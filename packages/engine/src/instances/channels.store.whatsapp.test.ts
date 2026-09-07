// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the WhatsApp-specific behaviour of
 * packages/engine/src/instances/channels.store.ts: `setChannelConfig`
 * validation/pruning/trimming and the webhook-secret invariant (mint /
 * carry-forward / destroy / rotate). Split out of `channels.store.test.ts`
 * to keep that file under the ≤400-line rule — self-contained with its own
 * mocks. Pure schema/helper coverage lives in
 * `channels.store.whatsapp-schema.test.ts` (split for the same reason).
 *
 * `setChannelConfig` now reads its OWN prior row (item 1 of the final
 * hardening pass) to carry the secret forward across an unrelated-field
 * save, instead of trusting a `webhookSecret` the caller hands back in
 * `config`. `mockDb.select`/`mockDb.insert` below fake a single persisted
 * row (`storedRow`) so that lifecycle — mint, carry-forward, destroy on mode
 * switch, re-mint on switch-back — can be exercised across successive
 * `setChannelConfig` calls, the way it actually happens in production.
 */

// ---------------------------------------------------------------------------
// Chain mock helper (read side)
// ---------------------------------------------------------------------------
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => self);
      }
      return chain[prop];
    },
  });
  return self;
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockDb, mockEncrypt, mockDecrypt, mockGenerateToken } = vi.hoisted(() => {
  let tokenCounter = 0;
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  const mockEncrypt = vi.fn((v: string) => `encrypted:${v}`);
  const mockDecrypt = vi.fn((v: string) => v.replace("encrypted:", ""));
  // Distinct-per-call, hex-shaped tokens (real `generateToken(32)` returns 64
  // hex chars) so a lifecycle test can assert two mints produced different
  // secrets, not just that both happen to look like a token.
  const mockGenerateToken = vi.fn(() => (++tokenCounter).toString(16).padStart(64, "0"));
  return { mockDb, mockEncrypt, mockDecrypt, mockGenerateToken };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("../crypto/index.js", () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
  generateToken: mockGenerateToken,
}));

vi.mock("./schema.js", () => ({
  instances: { id: "id", slug: "slug" },
}));

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

// ---------------------------------------------------------------------------
// Imports (after mocks) -- zod is NOT mocked
// ---------------------------------------------------------------------------
import { ZodError } from "zod";
import { setChannelConfig } from "./channels.store.js";
import { asInstanceUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const INSTANCE_UUID = asInstanceUuid("uuid-instance-1");
const ACCOUNT_SID = "AC00000000000000000000000000000001";
const API_KEY_SID = "SK00000000000000000000000000000002";
const NUMBER = "+14155238886";

/** The one row `setChannelConfig` reads/writes in these tests, faking real persistence. */
let storedRow: { config: string } | null = null;

function seedStoredRow(config: Record<string, unknown>): void {
  storedRow = { config: `encrypted:${JSON.stringify(config)}` };
}

/** The config actually persisted by the most recent `setChannelConfig` call. */
function lastPersistedConfig(): Record<string, unknown> {
  return JSON.parse((storedRow as { config: string }).config.replace("encrypted:", "")) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  storedRow = null;
  mockDb.select.mockImplementation(() => createChainMock(storedRow ? [{ config: storedRow.config }] : []));
  mockDb.insert.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((values: { config: string }) => {
      storedRow = { config: values.config };
      return chain;
    });
    chain.onConflictDoUpdate = vi.fn(() => chain);
    return chain;
  });
  // Real `db.transaction` hands the callback a tx client; the fake here hands
  // it the SAME `mockDb` so `select`/`insert` inside the callback are the
  // exact spies these tests already assert on.
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
});

describe("instances/channels.store — WhatsApp credential modes", () => {
  // -----------------------------------------------------------------------
  // setChannelConfig — validation, trimming, pruning
  // -----------------------------------------------------------------------
  describe("setChannelConfig (whatsapp)", () => {
    it("validates config, encrypts JSON, and upserts (authToken mode)", async () => {
      const config = { accountSid: ACCOUNT_SID, authToken: "token", whatsappNumber: NUMBER };
      await setChannelConfig(INSTANCE_UUID, "whatsapp", config, true);

      // The persisted value is the PARSED config, so a legacy payload missing
      // `authMode` is normalized (defaulted to "authToken") before it is
      // encrypted — not the raw input.
      expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify({ authMode: "authToken", ...config }));
      // authToken mode never needs the carry-forward read.
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("throws ZodError for invalid whatsapp config (missing accountSid)", async () => {
      await expect(
        setChannelConfig(INSTANCE_UUID, "whatsapp", { authToken: "tok", whatsappNumber: "+1" }, true),
      ).rejects.toThrow(ZodError);
      expect(mockEncrypt).not.toHaveBeenCalled();
    });

    it("throws ZodError for invalid whatsapp config (bad phone format)", async () => {
      await expect(
        setChannelConfig(
          INSTANCE_UUID,
          "whatsapp",
          { accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: "nope" },
          true,
        ),
      ).rejects.toThrow(ZodError);
    });

    it("should_persist_trimmed_credentials", async () => {
      const config = {
        authMode: "authToken",
        accountSid: ` ${ACCOUNT_SID} `,
        authToken: " tok\n",
        whatsappNumber: NUMBER,
      };
      await setChannelConfig(INSTANCE_UUID, "whatsapp", config, true);

      const encryptedPayload = mockEncrypt.mock.calls[0][0] as string;
      expect(encryptedPayload).toContain(ACCOUNT_SID);
      expect(encryptedPayload).toContain("tok");
      expect(encryptedPayload).not.toContain(` ${ACCOUNT_SID} `);
      expect(encryptedPayload).not.toContain(" tok\n");
    });

    it("should_not_persist_stale_credentials_from_the_other_mode_and_ignores_a_caller_supplied_secret", async () => {
      const config = {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        // A caller-supplied secret — irrelevant now that the store owns the
        // invariant end to end. With no prior row, it must be ignored, not
        // carried through: the store mints its own.
        webhookSecret: "attacker-or-stale-value",
        whatsappNumber: NUMBER,
        authToken: "stale",
      };
      const result = await setChannelConfig(INSTANCE_UUID, "whatsapp", config, true);

      expect(result.config).not.toHaveProperty("authToken");
      expect(result.mintedWebhookSecret).toBe(true);
      expect(result.config.webhookSecret).not.toBe("attacker-or-stale-value");
      expect(result.config.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // -------------------------------------------------------------------
  // Webhook secret invariant — the ONE chokepoint guaranteeing a stored
  // apiKey config always carries a server-controlled webhookSecret.
  // -------------------------------------------------------------------
  describe("webhook secret invariant", () => {
    it("should_mint_a_webhook_secret_on_the_first_save_in_apiKey_mode", async () => {
      const result = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        { authMode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec", whatsappNumber: NUMBER },
        true,
      );

      expect(result.mintedWebhookSecret).toBe(true);
      expect(result.config.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should_NOT_rotate_an_existing_webhook_secret_on_an_unrelated_field_save — the non-rotation invariant", async () => {
      // Simulate a pre-existing apiKey-mode row: the CALLER no longer carries
      // the secret in `config` at all (CHANNEL_CONFIG_KEYS.whatsapp omits it)
      // — the store must find it by reading its own prior row.
      seedStoredRow({
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        webhookSecret: "keep-me",
        whatsappNumber: NUMBER,
      });

      const result = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        {
          authMode: "apiKey",
          accountSid: ACCOUNT_SID,
          apiKeySid: API_KEY_SID,
          apiKeySecret: "sec",
          whatsappNumber: "+19998887777",
        },
        true,
      );

      expect(result.mintedWebhookSecret).toBe(false);
      expect(result.config.webhookSecret).toBe("keep-me");
      expect(result.config.whatsappNumber).toBe("+19998887777");
    });

    it("should_not_mint_a_secret_for_authToken_mode", async () => {
      const result = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: NUMBER },
        true,
      );

      expect(result.mintedWebhookSecret).toBe(false);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("should_not_mint_a_secret_for_non_whatsapp_channels", async () => {
      const result = await setChannelConfig(INSTANCE_UUID, "telegram", { botToken: "123:ABC" }, true);

      expect(result.mintedWebhookSecret).toBe(false);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("should_set_exactly_the_rotateWebhookSecretTo_value_and_report_no_mint", async () => {
      seedStoredRow({
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        webhookSecret: "old-secret",
        whatsappNumber: NUMBER,
      });

      const result = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        { authMode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec", whatsappNumber: NUMBER },
        true,
        { rotateWebhookSecretTo: "explicit-rotated-value" },
      );

      expect(result.mintedWebhookSecret).toBe(false);
      expect(result.config.webhookSecret).toBe("explicit-rotated-value");
      // A rotation does not consult the prior row's secret at all.
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("mints, carries forward, destroys on switch to authToken, and re-mints on switch back", async () => {
      const first = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        { authMode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec", whatsappNumber: NUMBER },
        true,
      );
      expect(first.mintedWebhookSecret).toBe(true);
      const secretA = first.config.webhookSecret as string;

      const second = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        {
          authMode: "apiKey",
          accountSid: ACCOUNT_SID,
          apiKeySid: API_KEY_SID,
          apiKeySecret: "sec",
          whatsappNumber: "+19998887777",
        },
        true,
      );
      expect(second.mintedWebhookSecret).toBe(false);
      expect(second.config.webhookSecret).toBe(secretA);
      expect(lastPersistedConfig().webhookSecret).toBe(secretA);

      const third = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: NUMBER },
        true,
      );
      expect(third.mintedWebhookSecret).toBe(false);
      expect(third.config).not.toHaveProperty("webhookSecret");

      const fourth = await setChannelConfig(
        INSTANCE_UUID,
        "whatsapp",
        { authMode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec", whatsappNumber: NUMBER },
        true,
      );
      expect(fourth.mintedWebhookSecret).toBe(true);
      expect(fourth.config.webhookSecret).not.toBe(secretA);
    });
  });

  // Read-then-write transactionality of the carry-forward path (#279) lives
  // in `channels.store.whatsapp-transaction.test.ts`, and pure schema/helper
  // coverage (`channelConfigSchemas.whatsapp`, `pruneWhatsAppCredentials`,
  // `resolveWhatsAppAuthMode`) in `channels.store.whatsapp-schema.test.ts` —
  // both split out to keep this file ≤400 lines.
});
