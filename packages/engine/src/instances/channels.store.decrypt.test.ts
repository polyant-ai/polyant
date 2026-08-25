// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for `safeDecryptConfig` in packages/engine/src/instances/channels.store.ts,
 * exercised indirectly through `getChannelConfig` / `listChannelConfigs` (the
 * function itself is not exported). Split out of `channels.store.test.ts` to
 * keep that file under the ≤400-line rule — self-contained with its own mocks.
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
const { mockDb, mockDecrypt } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  const mockDecrypt = vi.fn((v: string) => v.replace("encrypted:", ""));
  return { mockDb, mockDecrypt };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("../crypto/index.js", () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: mockDecrypt,
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
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { getChannelConfig, listChannelConfigs } from "./channels.store.js";
import { asInstanceSlug } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const INSTANCE_SLUG = asInstanceSlug("default");
const INSTANCE_UUID = "uuid-instance-1";

function mockResolveInstanceId(found = true) {
  const chain = createChainMock(found ? [{ id: INSTANCE_UUID }] : []);
  mockDb.select.mockReturnValueOnce(chain as any);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("instances/channels.store — safeDecryptConfig (via getChannelConfig)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("does not crash when a channel has empty config string (listChannelConfigs)", async () => {
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

  it("gracefully handles mix of valid and corrupted configs (listChannelConfigs)", async () => {
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

  it("returns {} config and does not crash for empty config field (whatsapp)", async () => {
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
