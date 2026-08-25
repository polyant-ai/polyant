// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the pure WhatsApp credential-mode schema/helpers in
 * packages/engine/src/instances/channels.store.ts: `channelConfigSchemas.whatsapp`,
 * `pruneWhatsAppCredentials`, `resolveWhatsAppAuthMode`. No DB is involved —
 * split out of `channels.store.whatsapp.test.ts` to keep both files under the
 * ≤400-line rule. Self-contained with its own (minimal) mocks, needed only so
 * importing `channels.store.js` does not touch a real DB/crypto module.
 */

vi.mock("../database/client.js", () => ({ db: {} }));
vi.mock("../crypto/index.js", () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateToken: vi.fn(),
}));
vi.mock("./schema.js", () => ({ instances: { id: "id", slug: "slug" } }));
vi.mock("./channels.schema.js", () => ({
  instanceChannels: {
    id: "id",
    instanceId: "instance_id",
    channelType: "channel_type",
    enabled: "enabled",
    config: "config",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
}));

import {
  channelConfigSchemas,
  pruneWhatsAppCredentials,
  resolveWhatsAppAuthMode,
  WHATSAPP_MODE_ONLY_KEYS,
  WHATSAPP_MODE_SCHEMAS,
} from "./channels.store.js";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const API_KEY_SID = "SK00000000000000000000000000000002";
const NUMBER = "+14155238886";

describe("instances/channels.store — whatsapp credential modes (schema)", () => {
  it("should_accept_an_auth_token_config", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      authMode: "authToken",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      whatsappNumber: NUMBER,
    });
    expect(parsed).toMatchObject({ authMode: "authToken", authToken: "tok" });
  });

  it("should_default_a_legacy_config_without_authMode_to_authToken", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      whatsappNumber: NUMBER,
    });
    expect(parsed).toMatchObject({ authMode: "authToken" });
  });

  it("should_accept_an_api_key_config", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      authMode: "apiKey",
      accountSid: ACCOUNT_SID,
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "deadbeef",
      whatsappNumber: NUMBER,
    });
    expect(parsed).toMatchObject({ authMode: "apiKey", apiKeySid: API_KEY_SID });
  });

  it("should_reject_an_api_key_config_without_a_webhook_secret", () => {
    expect(() =>
      channelConfigSchemas.whatsapp.parse({
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        whatsappNumber: NUMBER,
      }),
    ).toThrow();
  });

  it("should_reject_an_account_sid_that_is_actually_an_api_key_sid", () => {
    expect(() =>
      channelConfigSchemas.whatsapp.parse({
        authMode: "authToken",
        accountSid: API_KEY_SID,
        authToken: "tok",
        whatsappNumber: NUMBER,
      }),
    ).toThrow();
  });

  it("should_trim_pasted_credentials", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      authMode: "authToken",
      accountSid: ` ${ACCOUNT_SID} `,
      authToken: " tok\n",
      whatsappNumber: ` ${NUMBER} `,
    });
    expect(parsed).toMatchObject({ accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: NUMBER });
  });

  it("should_prune_api_key_fields_when_the_mode_is_authToken", () => {
    const pruned = pruneWhatsAppCredentials({
      authMode: "authToken",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "deadbeef",
      whatsappNumber: NUMBER,
    });
    expect(pruned).toEqual({
      authMode: "authToken",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      whatsappNumber: NUMBER,
    });
  });

  it("should_prune_the_auth_token_when_the_mode_is_apiKey", () => {
    const pruned = pruneWhatsAppCredentials({
      authMode: "apiKey",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "deadbeef",
      whatsappNumber: NUMBER,
    });
    expect(pruned).not.toHaveProperty("authToken");
    expect(pruned).toMatchObject({ apiKeySid: API_KEY_SID, webhookSecret: "deadbeef" });
  });

  it("should_resolve_a_missing_authMode_to_authToken", () => {
    expect(resolveWhatsAppAuthMode({ accountSid: ACCOUNT_SID })).toBe("authToken");
    expect(resolveWhatsAppAuthMode({ authMode: "apiKey" })).toBe("apiKey");
    expect(resolveWhatsAppAuthMode({ authMode: "nonsense" })).toBe("authToken");
  });

  // -------------------------------------------------------------------
  // #285 (item 1) — WHATSAPP_MODE_ONLY_KEYS has no sync test, unlike its
  // sibling CHANNEL_CONFIG_KEYS. This DERIVES the expected mode-only keys
  // from the mode schemas themselves (the field belongs to exactly one
  // mode's shape and not the other's) instead of restating the literal list
  // — a test that just repeated the current array would still pass if a
  // third field were added to one mode's schema and forgotten here, which
  // is exactly the failure this exists to catch. Verified by mutation (see
  // task report): adding a key to `whatsappApiKeyConfig` without adding it
  // to `WHATSAPP_MODE_ONLY_KEYS.apiKey` turns this test red.
  // -------------------------------------------------------------------
  describe("WHATSAPP_MODE_ONLY_KEYS", () => {
    it("should_match_exactly_the_keys_unique_to_each_mode_schema", () => {
      const authTokenKeys = new Set(Object.keys(WHATSAPP_MODE_SCHEMAS.authToken.shape));
      const apiKeyKeys = new Set(Object.keys(WHATSAPP_MODE_SCHEMAS.apiKey.shape));

      const authTokenOnly = [...authTokenKeys].filter((key) => !apiKeyKeys.has(key));
      const apiKeyOnly = [...apiKeyKeys].filter((key) => !authTokenKeys.has(key));

      expect([...WHATSAPP_MODE_ONLY_KEYS.authToken].sort()).toEqual(authTokenOnly.sort());
      expect([...WHATSAPP_MODE_ONLY_KEYS.apiKey].sort()).toEqual(apiKeyOnly.sort());
    });
  });
});
