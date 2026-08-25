// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database/client.js";
import { instanceChannels } from "./channels.schema.js";
import { encrypt, decrypt, generateToken } from "../crypto/index.js";
import { resolveInstanceId } from "./resolve-instance-id.js";
import { type InstanceSlug, type InstanceUuid } from "./identifiers.js";

/**
 * API-configurable channel types — narrow/closed set.
 *
 * Each entry here has a row in `instance_channels`, a config schema in
 * `channelConfigSchemas` below, and is exposed via the management API
 * (`PUT/DELETE /api/instances/:slug/channels/:type`).
 *
 * NOT the same as `MessageChannelType` in `channels/types.ts`, which is the
 * WIDE set covering every possible provenance of a pipeline message
 * (additionally includes `web`, `scheduled`, `room` which have no
 * per-instance stored credentials and are not API-configurable).
 *
 * Adding a new API-configurable channel:
 *   1. Append the literal to this tuple.
 *   2. Add a Zod schema entry below.
 *   3. Wire a case in `channel-manager.ts:createAdapter`.
 *   4. `MessageChannelType` widens automatically.
 *   5. Update any test mocks that hardcode this tuple.
 */
export const CHANNEL_TYPES = ["telegram", "slack", "whatsapp", "agent"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Named handle for the one channel type with credential-mode logic, to avoid inline literals at call sites. */
export const WHATSAPP_CHANNEL_TYPE: ChannelType = "whatsapp";

/** Safely decrypt channel config. Returns empty object if config is empty/invalid. */
function safeDecryptConfig(encrypted: string): Record<string, unknown> {
  if (!encrypted || !encrypted.includes(":")) return {};
  try {
    return JSON.parse(decrypt(encrypted)) as Record<string, unknown>;
  } catch (err) {
    console.error("[Channels] Failed to decrypt channel config:", err);
    return {};
  }
}

/**
 * Twilio accepts two credential shapes for the same account, and an operator
 * may hold only one of them:
 *   - `authToken` — the account's Auth Token. Also the ONLY key Twilio uses to
 *     sign inbound webhooks (HMAC-SHA1), so this mode keeps signature checks.
 *   - `apiKey` — a revocable API Key (`SK…` + secret). Twilio publishes no
 *     API-Key-keyed webhook signature, so this mode authenticates inbound with
 *     `webhookSecret` (server-generated, carried in the webhook path).
 */
export const WHATSAPP_AUTH_MODES = ["authToken", "apiKey"] as const;
export type WhatsAppAuthMode = (typeof WHATSAPP_AUTH_MODES)[number];

/** Named handles for the two modes, to avoid inline `"authToken"`/`"apiKey"` literals at call sites. */
export const [WHATSAPP_AUTH_MODE_TOKEN, WHATSAPP_AUTH_MODE_API_KEY] = WHATSAPP_AUTH_MODES;

/** Twilio SID formats: a 2-letter prefix followed by 32 hex characters. */
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID_PATTERN = /^SK[0-9a-fA-F]{32}$/;

const accountSidSchema = z
  .string()
  .trim()
  .regex(ACCOUNT_SID_PATTERN, "accountSid must be a Twilio Account SID (AC followed by 32 hex characters)");
const whatsappNumberSchema = z.string().trim().regex(/^\+\d+$/);

const whatsappAuthTokenConfig = z.object({
  authMode: z.literal("authToken"),
  accountSid: accountSidSchema,
  authToken: z.string().trim().min(1),
  whatsappNumber: whatsappNumberSchema,
});

const whatsappApiKeyConfig = z.object({
  authMode: z.literal("apiKey"),
  accountSid: accountSidSchema,
  apiKeySid: z
    .string()
    .trim()
    .regex(API_KEY_SID_PATTERN, "apiKeySid must be a Twilio API Key SID (SK followed by 32 hex characters)"),
  apiKeySecret: z.string().trim().min(1),
  // Server-generated (see CHANNEL_CONFIG_KEYS): required here so a config in
  // this mode can never be stored without an inbound authentication gate.
  webhookSecret: z.string().trim().min(1),
  whatsappNumber: whatsappNumberSchema,
});

/**
 * Configs stored before this feature carry no `authMode`. Defaulting it to
 * `authToken` here keeps every existing agent — and every existing Management
 * API caller that PUTs the three legacy keys — working unchanged.
 */
const whatsappConfigSchema = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null && !("authMode" in value)
      ? { authMode: "authToken", ...value }
      : value,
  z.discriminatedUnion("authMode", [whatsappAuthTokenConfig, whatsappApiKeyConfig]),
);

/** Config keys that belong to exactly one WhatsApp credential mode. */
const WHATSAPP_MODE_ONLY_KEYS: Record<WhatsAppAuthMode, readonly string[]> = {
  authToken: ["authToken"],
  apiKey: ["apiKeySid", "apiKeySecret", "webhookSecret"],
};

/** The stored mode, tolerating a legacy config that predates the field. */
export function resolveWhatsAppAuthMode(config: Record<string, unknown>): WhatsAppAuthMode {
  return config.authMode === "apiKey" ? "apiKey" : "authToken";
}

/**
 * Drop the credentials of the mode NOT in use. Without this, switching mode
 * would leave the discarded credential encrypted at rest forever.
 */
export function pruneWhatsAppCredentials(config: Record<string, unknown>): Record<string, unknown> {
  const mode = resolveWhatsAppAuthMode(config);
  const discard = mode === "apiKey" ? WHATSAPP_MODE_ONLY_KEYS.authToken : WHATSAPP_MODE_ONLY_KEYS.apiKey;
  return Object.fromEntries(Object.entries(config).filter(([key]) => !discard.includes(key)));
}

/** Zod schemas for channel-specific config validation. */
export const channelConfigSchemas: Record<ChannelType, z.ZodType> = {
  telegram: z.object({
    botToken: z.string().min(1),
    allowedUserIds: z.string().optional(),
  }),
  slack: z.object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
    signingSecret: z.string().min(1),
  }),
  whatsapp: whatsappConfigSchema,
  /**
   * Virtual in-process channel for agent-to-agent invocation. No external
   * credentials: enabling the row is the toggle that makes this instance
   * callable from other instances via the supervisor's `agent:{slug}` tool.
   * The config payload is intentionally open-passthrough — future per-pair
   * policies (allowed callers, default timeouts) can land here without a
   * schema migration.
   */
  agent: z.object({}).passthrough(),
};

/**
 * The config keys each channel type accepts from the management API — the
 * allowlist the PUT handler iterates instead of iterating the request body, so
 * no property name written into a stored config can come from remote input.
 *
 * `webhookSecret` is deliberately ABSENT: it is minted server-side, and letting
 * a caller supply it would defeat that.
 *
 * `agent` is deliberately empty. Its Zod schema is open-passthrough to leave
 * room for future per-pair policies, but no such key is consumed today.
 *
 * Keep in sync with `channelConfigSchemas` above (guarded by a unit test).
 */
export const CHANNEL_CONFIG_KEYS: Record<ChannelType, readonly string[]> = {
  telegram: ["botToken", "allowedUserIds"],
  slack: ["botToken", "appToken", "signingSecret"],
  whatsapp: ["authMode", "accountSid", "authToken", "apiKeySid", "apiKeySecret", "whatsappNumber"],
  agent: [],
};

export interface ChannelConfig {
  channelType: ChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SetChannelConfigOptions {
  /**
   * Replace the inbound webhook secret with this exact value. This is the
   * ONLY way to set it: a `webhookSecret` inside `config` is ignored and
   * stripped (see `prepareChannelConfig`), so no caller — however it obtained
   * the value — can promote a request-supplied string into the authenticator
   * of an unauthenticated route. Used by the explicit rotation endpoint.
   */
  rotateWebhookSecretTo?: string;
}

export interface SetChannelConfigResult {
  /** True when the store minted a new inbound webhook secret for this save. */
  mintedWebhookSecret: boolean;
  /** The config as actually persisted (schema-parsed, pruned, secret included). */
  config: Record<string, unknown>;
}

/**
 * Read the webhookSecret of the currently stored WhatsApp config, if any and
 * if it is in `apiKey` mode. Used only to carry the secret forward across a
 * save that does not rotate it — see `prepareChannelConfig`.
 */
async function readExistingApiKeyWebhookSecret(instanceId: InstanceUuid): Promise<string | undefined> {
  const rows = await db
    .select({ config: instanceChannels.config })
    .from(instanceChannels)
    .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.channelType, WHATSAPP_CHANNEL_TYPE)))
    .limit(1);
  if (!rows[0]) return undefined;

  const existing = safeDecryptConfig(rows[0].config);
  if (resolveWhatsAppAuthMode(existing) !== WHATSAPP_AUTH_MODE_API_KEY) return undefined;
  const secret = existing.webhookSecret;
  return typeof secret === "string" && secret ? secret : undefined;
}

/**
 * Channel-type-specific normalization applied before validation/persistence.
 * WhatsApp is the only type with a stateful invariant today — pruning the
 * unused credential mode's fields and, for `apiKey` mode, guaranteeing a
 * server-controlled inbound webhook secret. This is the SOLE chokepoint for
 * that invariant: a `webhookSecret` inside `config` is unconditionally
 * stripped before it reaches validation, so NO writer of `setChannelConfig` —
 * present or future — can let a caller-chosen value become the authenticator
 * of the unauthenticated inbound webhook route, even if it forgets to
 * allowlist the field itself. The only sanctioned way to set the secret is
 * `options.rotateWebhookSecretTo`.
 *
 * When the target mode is `apiKey` and no rotation was requested, the secret
 * is carried forward from the currently stored row (an extra read, scoped to
 * exactly this case — telegram/slack/agent saves and authToken-mode WhatsApp
 * saves never pay it) so a save that only touches an unrelated field (e.g.
 * `whatsappNumber`) never rotates the secret out from under an
 * already-configured Twilio Console. Its absence — first save in `apiKey`
 * mode, or the previous save was `authToken` mode — mints a fresh one.
 */
async function prepareChannelConfig(
  instanceId: InstanceUuid,
  channelType: ChannelType,
  config: Record<string, unknown>,
  options: SetChannelConfigOptions,
): Promise<{ config: Record<string, unknown>; mintedWebhookSecret: boolean }> {
  if (channelType !== WHATSAPP_CHANNEL_TYPE) {
    return { config, mintedWebhookSecret: false };
  }

  const withoutSecret: Record<string, unknown> = { ...config };
  delete withoutSecret.webhookSecret;
  const pruned = pruneWhatsAppCredentials(withoutSecret);

  if (resolveWhatsAppAuthMode(pruned) !== WHATSAPP_AUTH_MODE_API_KEY) {
    return { config: pruned, mintedWebhookSecret: false };
  }

  if (options.rotateWebhookSecretTo) {
    return { config: { ...pruned, webhookSecret: options.rotateWebhookSecretTo }, mintedWebhookSecret: false };
  }

  const existingSecret = await readExistingApiKeyWebhookSecret(instanceId);
  if (existingSecret) {
    return { config: { ...pruned, webhookSecret: existingSecret }, mintedWebhookSecret: false };
  }
  return { config: { ...pruned, webhookSecret: generateToken(32) }, mintedWebhookSecret: true };
}

/**
 * Set or update a channel config for an instance (by UUID).
 *
 * NOTE: `packages/engine/src/instances/import.service.ts` writes rows into
 * `instance_channels` directly, bypassing this function entirely. Only the
 * EXPORT side strips credential-like keys (`export.service.ts`) — the import
 * side does NOT: `export.schema.ts` types channel config as
 * `z.record(z.unknown())`, and `import.service.ts` computes `canEnable` by
 * `safeParse`-ing whatever the bundle contains. A hand-crafted bundle
 * carrying `authMode: "apiKey"` plus a caller-chosen `webhookSecret` satisfies
 * the union and IS written enabled, bypassing both the allowlist and the
 * invariant this function guarantees. Stripping on import is a tracked
 * follow-up, not yet implemented.
 *
 * What actually contains the blast radius today: `POST /api/instances/import`
 * requires `AGENT_WRITE`, and every system role holding `AGENT_WRITE` also
 * holds `CHANNEL_WRITE` (`authz/permissions.ts` — `MEMBER_PERMISSIONS` grants
 * both together, and `admin`/`owner` inherit both) — so importing a bundle
 * crosses no role boundary a caller couldn't already cross directly via the
 * channels PUT endpoint. Also, import never starts channel adapters: an
 * imported WhatsApp channel only goes live at the next engine boot, not
 * immediately on import.
 */
export async function setChannelConfig(
  instanceId: InstanceUuid,
  channelType: ChannelType,
  config: Record<string, unknown>,
  enabled: boolean,
  options: SetChannelConfigOptions = {},
): Promise<SetChannelConfigResult> {
  const { config: prepared, mintedWebhookSecret } = await prepareChannelConfig(
    instanceId,
    channelType,
    config,
    options,
  );

  // Validate config against channel schema. Persist the PARSED value, not the
  // raw input: the schemas trim pasted credentials and drop keys that do not
  // belong to the validated shape, and both only take effect if the parsed
  // result is what gets encrypted.
  const schema = channelConfigSchemas[channelType];
  const parsed = schema.parse(prepared) as Record<string, unknown>;

  const encryptedConfig = encrypt(JSON.stringify(parsed));

  await db
    .insert(instanceChannels)
    .values({ instanceId, channelType, enabled, config: encryptedConfig })
    .onConflictDoUpdate({
      target: [instanceChannels.instanceId, instanceChannels.channelType],
      set: { enabled, config: encryptedConfig, updatedAt: new Date() },
    });

  return { mintedWebhookSecret, config: parsed };
}

/** Get a single channel config for an instance (by slug). */
export async function getChannelConfig(
  instanceSlug: InstanceSlug,
  channelType: ChannelType,
): Promise<ChannelConfig | null> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) return null;

  const rows = await db
    .select({
      channelType: instanceChannels.channelType,
      enabled: instanceChannels.enabled,
      config: instanceChannels.config,
    })
    .from(instanceChannels)
    .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.channelType, channelType)))
    .limit(1);

  if (!rows[0]) return null;

  return {
    channelType: rows[0].channelType as ChannelType,
    enabled: rows[0].enabled,
    config: safeDecryptConfig(rows[0].config),
  };
}

/** List all channel configs for an instance (by slug). */
export async function listChannelConfigs(instanceSlug: InstanceSlug): Promise<ChannelConfig[]> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) return [];

  const rows = await db
    .select({
      channelType: instanceChannels.channelType,
      enabled: instanceChannels.enabled,
      config: instanceChannels.config,
    })
    .from(instanceChannels)
    .where(eq(instanceChannels.instanceId, instanceId));

  return rows.map((row) => ({
    channelType: row.channelType as ChannelType,
    enabled: row.enabled,
    config: safeDecryptConfig(row.config),
  }));
}

/** List all enabled channel configs for an instance (by slug). */
export async function listEnabledChannelConfigs(instanceSlug: InstanceSlug): Promise<ChannelConfig[]> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) return [];

  const rows = await db
    .select({
      channelType: instanceChannels.channelType,
      enabled: instanceChannels.enabled,
      config: instanceChannels.config,
    })
    .from(instanceChannels)
    .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.enabled, true)));

  return rows.map((row) => ({
    channelType: row.channelType as ChannelType,
    enabled: row.enabled,
    config: safeDecryptConfig(row.config),
  }));
}

/** Disable a channel by slug + type (used by auto-disable on adapter failure). */
export async function disableChannel(instanceSlug: InstanceSlug, channelType: string): Promise<void> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) return;
  await db
    .update(instanceChannels)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.channelType, channelType)));
}

/** Delete a channel config by instance UUID + channel type. */
export async function deleteChannelConfig(instanceId: InstanceUuid, channelType: ChannelType): Promise<void> {
  await db
    .delete(instanceChannels)
    .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.channelType, channelType)));
}
