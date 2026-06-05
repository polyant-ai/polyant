// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/instances/channels.store.ts
 *
 * Tests: setChannelConfig, getChannelConfig, listChannelConfigs,
 * listEnabledChannelConfigs, deleteChannelConfig.
 * Zod validation is NOT mocked (real schemas are used).
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
  // setChannelConfig
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

    it("validates config, encrypts JSON, and upserts (whatsapp)", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      const config = { accountSid: "AC123", authToken: "token", whatsappNumber: "+14155238886" };
      await setChannelConfig(INSTANCE_UUID, "whatsapp", config, true);

      expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify(config));
      expect(mockDb.insert).toHaveBeenCalled();
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

    it("throws ZodError for invalid whatsapp config (missing accountSid)", async () => {
      await expect(
        setChannelConfig(INSTANCE_UUID, "whatsapp", { authToken: "tok", whatsappNumber: "+1" }, true),
      ).rejects.toThrow(ZodError);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("throws ZodError for invalid whatsapp config (bad phone format)", async () => {
      await expect(
        setChannelConfig(INSTANCE_UUID, "whatsapp", { accountSid: "AC1", authToken: "tok", whatsappNumber: "nope" }, true),
      ).rejects.toThrow(ZodError);

      expect(mockDb.insert).not.toHaveBeenCalled();
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

      expect(mockDb.delete).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // safeDecryptConfig edge cases (exercised through getChannelConfig / listChannelConfigs)
  // -----------------------------------------------------------------------
  describe("safeDecryptConfig (via getChannelConfig)", () => {
    it("returns {} config when encrypted config is empty string", async () => {
      mockResolveInstanceId(true);
      const configChain = createChainMock([
        { channelType: "telegram", enabled: true, config: "" },
      ]);
      mockDb.select.mockReturnValueOnce(configChain as any);

      const result = await getChannelConfig(INSTANCE_SLUG, "telegram");

      expect(result).toEqual({
        channelType: "telegram",
        enabled: true,
        config: {},
      });
      // decrypt should NOT be called for empty string
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("returns {} config when encrypted string has no colons (invalid format)", async () => {
      mockResolveInstanceId(true);
      const configChain = createChainMock([
        { channelType: "slack", enabled: false, config: "nocolonshere" },
      ]);
      mockDb.select.mockReturnValueOnce(configChain as any);

      const result = await getChannelConfig(INSTANCE_SLUG, "slack");

      expect(result).toEqual({
        channelType: "slack",
        enabled: false,
        config: {},
      });
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("returns parsed object when encrypted config is valid", async () => {
      const originalConfig = { botToken: "123:ABC", allowedUserIds: "42" };
      const encryptedJson = `encrypted:${JSON.stringify(originalConfig)}`;

      mockResolveInstanceId(true);
      const configChain = createChainMock([
        { channelType: "telegram", enabled: true, config: encryptedJson },
      ]);
      mockDb.select.mockReturnValueOnce(configChain as any);

      const result = await getChannelConfig(INSTANCE_SLUG, "telegram");

      expect(result).toEqual({
        channelType: "telegram",
        enabled: true,
        config: originalConfig,
      });
      expect(mockDecrypt).toHaveBeenCalledWith(encryptedJson);
    });

    it("returns {} config when decrypt throws (corrupted/wrong key)", async () => {
      mockResolveInstanceId(true);
      // The config has a colon so safeDecryptConfig will attempt decrypt
      const configChain = createChainMock([
        { channelType: "whatsapp", enabled: true, config: "corrupted:garbage:data" },
      ]);
      mockDb.select.mockReturnValueOnce(configChain as any);

      // Make decrypt throw to simulate wrong key / corrupted data
      mockDecrypt.mockImplementationOnce(() => {
        throw new Error("Unsupported state or unable to authenticate data");
      });

      const result = await getChannelConfig(INSTANCE_SLUG, "whatsapp");

      expect(result).toEqual({
        channelType: "whatsapp",
        enabled: true,
        config: {},
      });
      expect(mockDecrypt).toHaveBeenCalledWith("corrupted:garbage:data");
    });

    it("returns {} config when decrypt returns invalid JSON", async () => {
      mockResolveInstanceId(true);
      const configChain = createChainMock([
        { channelType: "telegram", enabled: true, config: "iv:not-json" },
      ]);
      mockDb.select.mockReturnValueOnce(configChain as any);

      // decrypt succeeds but returns non-JSON
      mockDecrypt.mockReturnValueOnce("this is not json");

      const result = await getChannelConfig(INSTANCE_SLUG, "telegram");

      expect(result).toEqual({
        channelType: "telegram",
        enabled: true,
        config: {},
      });
    });
  });

  // -----------------------------------------------------------------------
  // listChannelConfigs with empty/corrupt config
  // -----------------------------------------------------------------------
  describe("listChannelConfigs with empty config", () => {
    it("does not crash when a channel has empty config string", async () => {
      mockResolveInstanceId(true);
      const listChain = createChainMock([
        { channelType: "telegram", enabled: true, config: "" },
        { channelType: "slack", enabled: false, config: "nocolon" },
      ]);
      mockDb.select.mockReturnValueOnce(listChain as any);

      const result = await listChannelConfigs(INSTANCE_SLUG);

      expect(result).toHaveLength(2);
      expect(result[0].config).toEqual({});
      expect(result[1].config).toEqual({});
      // decrypt should not be called for either (empty or no colon)
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("gracefully handles mix of valid and corrupted configs", async () => {
      const validConfig = { botToken: "123:ABC" };
      const encryptedValid = `encrypted:${JSON.stringify(validConfig)}`;

      mockResolveInstanceId(true);
      const listChain = createChainMock([
        { channelType: "telegram", enabled: true, config: encryptedValid },
        { channelType: "slack", enabled: false, config: "bad:corrupted" },
      ]);
      mockDb.select.mockReturnValueOnce(listChain as any);

      // First call (telegram) succeeds, second call (slack) throws
      mockDecrypt
        .mockReturnValueOnce(JSON.stringify(validConfig))
        .mockImplementationOnce(() => { throw new Error("decrypt failed"); });

      const result = await listChannelConfigs(INSTANCE_SLUG);

      expect(result).toHaveLength(2);
      expect(result[0].config).toEqual(validConfig);
      expect(result[1].config).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // getChannelConfig with empty config (explicit)
  // -----------------------------------------------------------------------
  describe("getChannelConfig with empty config", () => {
    it("returns {} config and does not crash for empty config field", async () => {
      mockResolveInstanceId(true);
      const configChain = createChainMock([
        { channelType: "whatsapp", enabled: false, config: "" },
      ]);
      mockDb.select.mockReturnValueOnce(configChain as any);

      const result = await getChannelConfig(INSTANCE_SLUG, "whatsapp");

      expect(result).not.toBeNull();
      expect(result!.config).toEqual({});
      expect(result!.channelType).toBe("whatsapp");
      expect(result!.enabled).toBe(false);
    });
  });
});
