// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/instances/channels.store.ts
 *
 * Tests: setChannelConfig (telegram/slack + generic validation),
 * getChannelConfig, listChannelConfigs, listEnabledChannelConfigs,
 * deleteChannelConfig, CHANNEL_CONFIG_KEYS.
 * Zod validation is NOT mocked (real schemas are used).
 *
 * WhatsApp credential-mode + webhook-secret-minting coverage lives in the
 * sibling `channels.store.whatsapp.test.ts`; `safeDecryptConfig` edge cases
 * live in `channels.store.decrypt.test.ts` — both split out to keep this
 * file under the ≤400-line rule.
 */

// ---------------------------------------------------------------------------
// Chain mock helper
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
const { mockDb, mockEncrypt, mockDecrypt } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  const mockEncrypt = vi.fn((v: string) => `encrypted:${v}`);
  const mockDecrypt = vi.fn((v: string) => v.replace("encrypted:", ""));
  return { mockDb, mockEncrypt, mockDecrypt };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("../crypto/index.js", () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
  // Deterministic-shaped fake token (real `generateToken` returns 64 hex
  // chars for `generateToken(32)`) so tests can assert on the shape.
  generateToken: vi.fn(() => "a".repeat(64)),
}));

vi.mock("./schema.js", () => ({
  instances: {
    id: "id",
    slug: "slug",
  },
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
import {
  CHANNEL_TYPES,
  CHANNEL_CONFIG_KEYS,
  setChannelConfig,
  getChannelConfig,
  listChannelConfigs,
  listEnabledChannelConfigs,
  deleteChannelConfig,
} from "./channels.store.js";
import { asInstanceSlug, asInstanceUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const INSTANCE_UUID = asInstanceUuid("uuid-instance-1");
const INSTANCE_SLUG = asInstanceSlug("default");

function mockResolveInstanceId(found = true) {
  const chain = createChainMock(found ? [{ id: INSTANCE_UUID }] : []);
  mockDb.select.mockReturnValueOnce(chain as any);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("instances/channels.store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // CHANNEL_TYPES constant
  // -----------------------------------------------------------------------
  describe("CHANNEL_TYPES", () => {
    it("exports the four supported channel types (telegram, slack, whatsapp, agent)", () => {
      expect(CHANNEL_TYPES).toEqual(["telegram", "slack", "whatsapp", "agent"]);
    });
  });

  // -----------------------------------------------------------------------
  // setChannelConfig (telegram/slack — generic path, no WhatsApp invariant)
  // -----------------------------------------------------------------------
  describe("setChannelConfig", () => {
    it("validates config, encrypts JSON, and upserts (telegram)", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      const config = { botToken: "123:ABC" };
      await setChannelConfig(INSTANCE_UUID, "telegram", config, true);

      expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify(config));
      expect(mockDb.insert).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalledWith({
        instanceId: INSTANCE_UUID,
        channelType: "telegram",
        enabled: true,
        config: `encrypted:${JSON.stringify(config)}`,
      });
      expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it("validates config, encrypts JSON, and upserts (slack)", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      const config = {
        botToken: "xoxb-token",
        appToken: "xapp-token",
        signingSecret: "secret123",
      };
      await setChannelConfig(INSTANCE_UUID, "slack", config, false);

      expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify(config));
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("returns the persisted (schema-parsed) config in the result", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      const config = { botToken: "123:ABC" };
      const result = await setChannelConfig(INSTANCE_UUID, "telegram", config, true);

      expect(result.config).toEqual(config);
      expect(result.mintedWebhookSecret).toBe(false);
    });

    it("throws ZodError for invalid telegram config (missing botToken)", async () => {
      await expect(
        setChannelConfig(INSTANCE_UUID, "telegram", {}, true),
      ).rejects.toThrow(ZodError);

      expect(mockEncrypt).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("throws ZodError for invalid slack config (missing fields)", async () => {
      await expect(
        setChannelConfig(INSTANCE_UUID, "slack", { botToken: "xoxb" }, true),
      ).rejects.toThrow(ZodError);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("does not query the DB for a non-whatsapp save (no carry-forward read to make)", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await setChannelConfig(INSTANCE_UUID, "telegram", { botToken: "123:ABC" }, true);

      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getChannelConfig
  // -----------------------------------------------------------------------
  describe("getChannelConfig", () => {
    it("resolves slug, fetches, and decrypts the channel config", async () => {
      const telegramConfig = { botToken: "123:ABC" };
      const encryptedJson = `encrypted:${JSON.stringify(telegramConfig)}`;

      mockResolveInstanceId(true);
      const configChain = createChainMock([
        { channelType: "telegram", enabled: true, config: encryptedJson },
      ]);
      mockDb.select.mockReturnValueOnce(configChain as any);

      const result = await getChannelConfig(INSTANCE_SLUG, "telegram");

      expect(result).toEqual({
        channelType: "telegram",
        enabled: true,
        config: telegramConfig,
      });
      expect(mockDecrypt).toHaveBeenCalledWith(encryptedJson);
    });

    it("returns null when instance slug is not found", async () => {
      mockResolveInstanceId(false);

      const result = await getChannelConfig(asInstanceSlug("nonexistent"), "telegram");

      expect(result).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("returns null when channel config does not exist", async () => {
      mockResolveInstanceId(true);
      const emptyChain = createChainMock([]);
      mockDb.select.mockReturnValueOnce(emptyChain as any);

      const result = await getChannelConfig(INSTANCE_SLUG, "slack");

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // listChannelConfigs
  // -----------------------------------------------------------------------
  describe("listChannelConfigs", () => {
    it("returns all channel configs for an instance", async () => {
      const telegramConfig = { botToken: "123:ABC" };
      const slackConfig = { botToken: "xoxb", appToken: "xapp", signingSecret: "sec" };

      mockResolveInstanceId(true);
      const listChain = createChainMock([
        { channelType: "telegram", enabled: true, config: `encrypted:${JSON.stringify(telegramConfig)}` },
        { channelType: "slack", enabled: false, config: `encrypted:${JSON.stringify(slackConfig)}` },
      ]);
      mockDb.select.mockReturnValueOnce(listChain as any);

      const result = await listChannelConfigs(INSTANCE_SLUG);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        channelType: "telegram",
        enabled: true,
        config: telegramConfig,
      });
      expect(result[1]).toEqual({
        channelType: "slack",
        enabled: false,
        config: slackConfig,
      });
      expect(mockDecrypt).toHaveBeenCalledTimes(2);
    });

    it("returns empty array when instance not found", async () => {
      mockResolveInstanceId(false);

      const result = await listChannelConfigs(asInstanceSlug("nonexistent"));

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // listEnabledChannelConfigs
  // -----------------------------------------------------------------------
  describe("listEnabledChannelConfigs", () => {
    it("returns only enabled channel configs", async () => {
      const telegramConfig = { botToken: "123:ABC" };

      mockResolveInstanceId(true);
      const listChain = createChainMock([
        { channelType: "telegram", enabled: true, config: `encrypted:${JSON.stringify(telegramConfig)}` },
      ]);
      mockDb.select.mockReturnValueOnce(listChain as any);

      const result = await listEnabledChannelConfigs(INSTANCE_SLUG);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        channelType: "telegram",
        enabled: true,
        config: telegramConfig,
      });
    });

    it("returns empty array when instance not found", async () => {
      mockResolveInstanceId(false);

      const result = await listEnabledChannelConfigs(asInstanceSlug("nonexistent"));

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // deleteChannelConfig
  // -----------------------------------------------------------------------
  describe("deleteChannelConfig", () => {
    it("deletes the channel config by instanceId and channelType", async () => {
      const chain = createChainMock(undefined);
      mockDb.delete.mockReturnValue(chain as any);

      await deleteChannelConfig(INSTANCE_UUID, "telegram");

    /*
      Assert the PREDICATE, not that `.where()` was called.

      The chain mock is a Proxy whose every property returns itself, so any chain
      shape resolves and `expect(chain.where).toHaveBeenCalled()` passes for a
      delete with no condition at all. Dropping the key predicate wipes every
      secret of that agent; dropping the instance predicate wipes that key for
      EVERY tenant. Both kept the old assertion green.
    */
      expect(mockDb.delete).toHaveBeenCalled();
      expect(chain.where.mock.calls[0][0]).toEqual({
        type: "and",
        args: [
          { type: "eq", args: ["instance_id", INSTANCE_UUID] },
          { type: "eq", args: ["channel_type", "telegram"] },
        ],
      });
    });
  });

  // `safeDecryptConfig` edge cases (via getChannelConfig/listChannelConfigs)
  // moved to `channels.store.decrypt.test.ts` to keep this file ≤400 lines.

  describe("CHANNEL_CONFIG_KEYS", () => {
    it("should_cover_every_channel_type", () => {
      expect(Object.keys(CHANNEL_CONFIG_KEYS).sort()).toEqual([...CHANNEL_TYPES].sort());
    });

    it("should_not_expose_the_server_generated_webhook_secret", () => {
      expect(CHANNEL_CONFIG_KEYS.whatsapp).not.toContain("webhookSecret");
    });

    it("should_accept_both_credential_modes_for_whatsapp", () => {
      expect(CHANNEL_CONFIG_KEYS.whatsapp).toEqual([
        "authMode",
        "accountSid",
        "authToken",
        "apiKeySid",
        "apiKeySecret",
        "whatsappNumber",
      ]);
    });
  });
});
