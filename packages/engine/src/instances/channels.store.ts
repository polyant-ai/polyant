// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, type DbExecutor, type DbTransaction } from "../database/client.js";
import { instanceChannels } from "./channels.schema.js";
import { encrypt, decrypt, generateToken } from "../crypto/index.js";
import { resolveInstanceId } from "./resolve-instance-id.js";
import { type InstanceSlug, type InstanceUuid } from "./identifiers.js";
import {
  whatsappConfigSchema,
  resolveWhatsAppAuthMode,
  pruneAndResolveWhatsAppConfig,
  WHATSAPP_AUTH_MODE_API_KEY,
} from "./whatsapp-channel-config.js";

// Re-exported so every existing caller can keep importing WhatsApp
// credential-mode symbols from `channels.store.js` — the actual schemas and
// pure helpers live in `whatsapp-channel-config.ts`, split out to keep this
// file ≤400 lines.
export {
  WHATSAPP_AUTH_MODES,
  type WhatsAppAuthMode,
  WHATSAPP_AUTH_MODE_TOKEN,
  WHATSAPP_AUTH_MODE_API_KEY,
  WHATSAPP_MODE_SCHEMAS,
  WHATSAPP_MODE_ONLY_KEYS,
  resolveWhatsAppAuthMode,
  pruneWhatsAppCredentials,
} from "./whatsapp-channel-config.js";

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

/**
 * Named handle for the one channel type with credential-mode logic, to avoid
 * inline literals at call sites. `as const satisfies ChannelType` (rather
 * than `: ChannelType`) keeps the literal type narrow, so `channelType !==
 * WHATSAPP_CHANNEL_TYPE` still narrows and a future `switch` over
 * `ChannelType` keeps exhaustiveness checking.
 */
export const WHATSAPP_CHANNEL_TYPE = "whatsapp" as const satisfies ChannelType;

/** Named handle for the virtual agent-to-agent channel type, to avoid inline `"agent"` literals at call sites. */
export const AGENT_CHANNEL_TYPE = "agent" as const satisfies ChannelType;

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
 * save that does not rotate it — see `setChannelConfig`.
 *
 * MUST run inside the same transaction as the upsert that follows, on a `tx`
 * that has already taken `FOR UPDATE` on this row (see #279): otherwise a
 * rotation or another save committing between this read and that upsert can
 * overwrite it with the value read here, undoing the concurrent write while
 * the audit log claims it succeeded.
 */
async function readExistingApiKeyWebhookSecretForUpdate(
  instanceId: InstanceUuid,
  tx: DbTransaction,
): Promise<string | undefined> {
  const rows = await tx
    .select({ config: instanceChannels.config })
    .from(instanceChannels)
    .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.channelType, WHATSAPP_CHANNEL_TYPE)))
    .for("update")
    .limit(1);
  if (!rows[0]) return undefined;

  const existing = safeDecryptConfig(rows[0].config);
  if (resolveWhatsAppAuthMode(existing) !== WHATSAPP_AUTH_MODE_API_KEY) return undefined;
  const secret = existing.webhookSecret;
  return typeof secret === "string" && secret ? secret : undefined;
}

/**
 * Validate `config` against its channel schema and upsert it, on the given
 * executor (the root `db`, or an open transaction for the one path that needs
 * one — see `setChannelConfig`). Persists the PARSED value, not the raw
 * input: the schemas trim pasted credentials and drop keys that do not belong
 * to the validated shape, and both only take effect if the parsed result is
 * what gets encrypted.
 */
async function persistChannelConfig(
  executor: DbExecutor,
  instanceId: InstanceUuid,
  channelType: ChannelType,
  config: Record<string, unknown>,
  enabled: boolean,
  mintedWebhookSecret: boolean,
): Promise<SetChannelConfigResult> {
  const schema = channelConfigSchemas[channelType];
  const parsed = schema.parse(config) as Record<string, unknown>;
  const encryptedConfig = encrypt(JSON.stringify(parsed));

  await executor
    .insert(instanceChannels)
    .values({ instanceId, channelType, enabled, config: encryptedConfig })
    .onConflictDoUpdate({
      target: [instanceChannels.instanceId, instanceChannels.channelType],
      set: { enabled, config: encryptedConfig, updatedAt: new Date() },
    });

  return { mintedWebhookSecret, config: parsed };
}

/**
 * Set or update a channel config for an instance (by UUID).
 *
 * WhatsApp is the only type with a stateful invariant today — pruning the
 * unused credential mode's fields and, for `apiKey` mode, guaranteeing a
 * server-controlled inbound webhook secret. This is the SOLE chokepoint for
 * that invariant: a `webhookSecret` inside `config` is unconditionally
 * stripped before it reaches validation, so NO caller of `setChannelConfig` —
 * present or future — can let a caller-chosen value become the authenticator
 * of the unauthenticated inbound webhook route, even if it forgets to
 * allowlist the field itself. The only sanctioned way to set the secret is
 * `options.rotateWebhookSecretTo`.
 *
 * When the target mode is `apiKey` and no rotation was requested, the secret
 * is carried forward from the currently stored row (an extra read, scoped to
 * exactly this case — telegram/slack/agent saves, authToken-mode WhatsApp
 * saves, and explicit rotations never pay it) so a save that only touches an
 * unrelated field (e.g. `whatsappNumber`) never rotates the secret out from
 * under an already-configured Twilio Console. Its absence — first save in
 * `apiKey` mode, or the previous save was `authToken` mode — mints a fresh
 * one.
 *
 * That carry-forward is the only read-then-write in this function, so it is
 * the only branch wrapped in `db.transaction` with a row lock on the read
 * (`readExistingApiKeyWebhookSecretForUpdate`, #279): a rotation or an
 * unrelated save committing between the read and the upsert below must not be
 * able to resurrect the value read here — the leaked secret this function
 * exists to retire would go live again while the audit log says otherwise.
 *
 * NOTE: `packages/engine/src/instances/import.service.ts` writes rows into
 * `instance_channels` directly, bypassing this function entirely.
 * `export.schema.ts` types channel config as `z.record(z.unknown())`, so
 * `import.service.ts` computes `canEnable` by `safeParse`-ing whatever the
 * bundle contains — a hand-crafted bundle carrying `authMode: "apiKey"` plus
 * a caller-chosen `webhookSecret` would otherwise satisfy the union and be
 * written enabled, bypassing both the allowlist and the invariant this
 * function guarantees. `import.service.ts` now runs the bundle's config
 * through `stripSensitiveKeys` (`channel-config-sanitize.ts`, shared with
 * `export.service.ts`) before it ever reaches `channelConfigSchemas`, so a
 * credential-like key can no longer survive the round trip either way.
 *
 * What further contains the blast radius: `POST /api/instances/import`
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
  if (channelType !== WHATSAPP_CHANNEL_TYPE) {
    return persistChannelConfig(db, instanceId, channelType, config, enabled, false);
  }

  const { pruned, mode } = pruneAndResolveWhatsAppConfig(config);

  if (mode !== WHATSAPP_AUTH_MODE_API_KEY) {
    return persistChannelConfig(db, instanceId, channelType, pruned, enabled, false);
  }

  if (options.rotateWebhookSecretTo) {
    const withSecret = { ...pruned, webhookSecret: options.rotateWebhookSecretTo };
    return persistChannelConfig(db, instanceId, channelType, withSecret, enabled, false);
  }

  return db.transaction(async (tx) => {
    const existingSecret = await readExistingApiKeyWebhookSecretForUpdate(instanceId, tx);
    const withSecret = { ...pruned, webhookSecret: existingSecret ?? generateToken(32) };
    return persistChannelConfig(tx, instanceId, channelType, withSecret, enabled, !existingSecret);
  });
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
