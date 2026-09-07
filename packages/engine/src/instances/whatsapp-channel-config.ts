// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

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
  // Server-generated (see CHANNEL_CONFIG_KEYS in channels.store.ts): required
  // here so a config in this mode can never be stored without an inbound
  // authentication gate.
  webhookSecret: z.string().trim().min(1),
  whatsappNumber: whatsappNumberSchema,
});

/**
 * Configs stored before this feature carry no `authMode`. Defaulting it to
 * `authToken` here keeps every existing agent — and every existing Management
 * API caller that PUTs the three legacy keys — working unchanged.
 */
export const whatsappConfigSchema = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null && !("authMode" in value)
      ? { authMode: "authToken", ...value }
      : value,
  z.discriminatedUnion("authMode", [whatsappAuthTokenConfig, whatsappApiKeyConfig]),
);

/**
 * The per-mode Zod object schemas, exported ONLY so a test can derive
 * `WHATSAPP_MODE_ONLY_KEYS` from the schema shape instead of restating the
 * list by hand (see the sync test in `channels.store.whatsapp-schema.test.ts`)
 * — a hand-restated expectation would pass even if a field were added to one
 * of these schemas and forgotten here.
 */
export const WHATSAPP_MODE_SCHEMAS = {
  authToken: whatsappAuthTokenConfig,
  apiKey: whatsappApiKeyConfig,
} satisfies Record<WhatsAppAuthMode, z.AnyZodObject>;

/** Config keys that belong to exactly one WhatsApp credential mode. */
export const WHATSAPP_MODE_ONLY_KEYS: Record<WhatsAppAuthMode, readonly string[]> = {
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

/**
 * Pure (no DB) half of WhatsApp config preparation: strip any caller-supplied
 * `webhookSecret` (see the chokepoint note on `setChannelConfig` in
 * `channels.store.ts`) and drop the credentials of the mode not in use. Split
 * out so `setChannelConfig` can decide — WITHOUT touching the DB — whether a
 * save needs the carry-forward read at all, and therefore whether it needs a
 * transaction.
 */
export function pruneAndResolveWhatsAppConfig(config: Record<string, unknown>): {
  pruned: Record<string, unknown>;
  mode: WhatsAppAuthMode;
} {
  const withoutSecret: Record<string, unknown> = { ...config };
  delete withoutSecret.webhookSecret;
  const pruned = pruneWhatsAppCredentials(withoutSecret);
  return { pruned, mode: resolveWhatsAppAuthMode(pruned) };
}
