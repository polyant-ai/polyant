// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/instances/secrets.store.ts
 *
 * Tests: setSecret, getSecret, getAllSecrets, getAllSecretsById,
 * listSecretKeys, deleteSecret, and the resolveInstanceId helper (indirectly).
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

vi.mock("./secrets.schema.js", () => ({
  instanceSecrets: {
    id: "id",
    instanceId: "instance_id",
    key: "key",
    value: "value",
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
import {
  SECRET_KEYS,
  setSecret,
  getSecret,
  getAllSecrets,
  getAllSecretsById,
  listSecretKeys,
  deleteSecret,
} from "./secrets.store.js";
import { asInstanceSlug, asInstanceUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const INSTANCE_UUID = asInstanceUuid("uuid-instance-1");
const INSTANCE_SLUG = asInstanceSlug("default");

/** Creates a select chain that resolves the slug to the UUID.
 *  Kept as a helper for future tests; silenced to avoid an unused-warning. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function mockResolveInstanceId(found = true) {
  const chain = createChainMock(found ? [{ id: INSTANCE_UUID }] : []);
  mockDb.select.mockReturnValue(chain as any);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("instances/secrets.store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // SECRET_KEYS constant
  // -----------------------------------------------------------------------
  describe("SECRET_KEYS", () => {
    it("exports all 12 well-known secret keys", () => {
      expect(Object.keys(SECRET_KEYS)).toHaveLength(12);
      expect(SECRET_KEYS.OPENAI_API_KEY).toBe("openai_api_key");
      expect(SECRET_KEYS.ANTHROPIC_API_KEY).toBe("anthropic_api_key");
      expect(SECRET_KEYS.AWS_ACCESS_KEY_ID).toBe("aws_access_key_id");
      expect(SECRET_KEYS.AWS_SECRET_ACCESS_KEY).toBe("aws_secret_access_key");
      expect(SECRET_KEYS.AWS_REGION).toBe("aws_region");
      expect(SECRET_KEYS.LANGSMITH_API_KEY).toBe("langsmith_api_key");
      expect(SECRET_KEYS.AUTH_API_KEY).toBe("auth_api_key");
      expect(SECRET_KEYS.TAVILY_API_KEY).toBe("tavily_api_key");
      expect(SECRET_KEYS.GITHUB_TOKEN).toBe("github_token");
      expect(SECRET_KEYS.S3_BUCKET_NAME).toBe("s3_bucket_name");
      expect(SECRET_KEYS.HTTP_API_KEY).toBe("http_api_key");
      expect(SECRET_KEYS.DEEPGRAM_API_KEY).toBe("deepgram_api_key");
    });
  });

  // -----------------------------------------------------------------------
  // setSecret
  // -----------------------------------------------------------------------
  describe("setSecret", () => {
    it("encrypts the value and upserts into the database", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await setSecret(INSTANCE_UUID, "openai_api_key", "sk-test-key");

      expect(mockEncrypt).toHaveBeenCalledWith("sk-test-key");
      expect(mockDb.insert).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalledWith({
        instanceId: INSTANCE_UUID,
        key: "openai_api_key",
        value: "encrypted:sk-test-key",
      });
      expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getSecret
  // -----------------------------------------------------------------------
  describe("getSecret", () => {
    it("resolves slug, fetches, and decrypts the secret", async () => {
      // First call: resolveInstanceId -> found
      const resolveChain = createChainMock([{ id: INSTANCE_UUID }]);
      // Second call: select the secret row
      const secretChain = createChainMock([{ value: "encrypted:sk-real-key" }]);

      mockDb.select
        .mockReturnValueOnce(resolveChain as any)
        .mockReturnValueOnce(secretChain as any);

      const result = await getSecret(INSTANCE_SLUG, "openai_api_key");

      expect(result).toBe("sk-real-key");
      expect(mockDecrypt).toHaveBeenCalledWith("encrypted:sk-real-key");
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });

    it("returns undefined when instance slug is not found", async () => {
      const resolveChain = createChainMock([]);
      mockDb.select.mockReturnValue(resolveChain as any);

      const result = await getSecret(asInstanceSlug("nonexistent"), "openai_api_key");

      expect(result).toBeUndefined();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("returns undefined when secret key does not exist", async () => {
      const resolveChain = createChainMock([{ id: INSTANCE_UUID }]);
      const secretChain = createChainMock([]);

      mockDb.select
        .mockReturnValueOnce(resolveChain as any)
        .mockReturnValueOnce(secretChain as any);

      const result = await getSecret(INSTANCE_SLUG, "nonexistent_key");

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getAllSecrets
  // -----------------------------------------------------------------------
  describe("getAllSecrets", () => {
    it("resolves slug and returns all decrypted secrets", async () => {
      const resolveChain = createChainMock([{ id: INSTANCE_UUID }]);
      const secretsChain = createChainMock([
        { key: "openai_api_key", value: "encrypted:sk-openai" },
        { key: "anthropic_api_key", value: "encrypted:sk-anthropic" },
      ]);

      mockDb.select
        .mockReturnValueOnce(resolveChain as any)
        .mockReturnValueOnce(secretsChain as any);

      const result = await getAllSecrets(INSTANCE_SLUG);

      expect(result).toEqual({
        openai_api_key: "sk-openai",
        anthropic_api_key: "sk-anthropic",
      });
      expect(mockDecrypt).toHaveBeenCalledTimes(2);
    });

    it("returns empty object when instance not found", async () => {
      const resolveChain = createChainMock([]);
      mockDb.select.mockReturnValue(resolveChain as any);

      const result = await getAllSecrets(asInstanceSlug("nonexistent"));

      expect(result).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // getAllSecretsById
  // -----------------------------------------------------------------------
  describe("getAllSecretsById", () => {
    it("returns all decrypted secrets by UUID (no slug resolution)", async () => {
      const secretsChain = createChainMock([
        { key: "openai_api_key", value: "encrypted:sk-openai" },
        { key: "tavily_api_key", value: "encrypted:tvly-key" },
      ]);
      mockDb.select.mockReturnValue(secretsChain as any);

      const result = await getAllSecretsById(INSTANCE_UUID);

      expect(result).toEqual({
        openai_api_key: "sk-openai",
        tavily_api_key: "tvly-key",
      });
      // Only 1 select call (no slug resolution)
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDecrypt).toHaveBeenCalledTimes(2);
    });

    it("returns empty object when no secrets exist", async () => {
      const chain = createChainMock([]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await getAllSecretsById(INSTANCE_UUID);

      expect(result).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // listSecretKeys
  // -----------------------------------------------------------------------
  describe("listSecretKeys", () => {
    it("returns all SECRET_KEYS with configured status", async () => {
      const resolveChain = createChainMock([{ id: INSTANCE_UUID }]);
      const keysChain = createChainMock([
        { key: "openai_api_key" },
        { key: "auth_api_key" },
      ]);

      mockDb.select
        .mockReturnValueOnce(resolveChain as any)
        .mockReturnValueOnce(keysChain as any);

      const result = await listSecretKeys(INSTANCE_SLUG);

      expect(result).toHaveLength(12);
      expect(result).toEqual(
        expect.arrayContaining([
          { key: "openai_api_key", configured: true },
          { key: "anthropic_api_key", configured: false },
          { key: "aws_access_key_id", configured: false },
          { key: "aws_secret_access_key", configured: false },
          { key: "aws_region", configured: false },
          { key: "langsmith_api_key", configured: false },
          { key: "auth_api_key", configured: true },
          { key: "tavily_api_key", configured: false },
          { key: "github_token", configured: false },
          { key: "s3_bucket_name", configured: false },
          { key: "http_api_key", configured: false },
          { key: "deepgram_api_key", configured: false },
        ]),
      );
    });

    it("returns empty array when instance not found", async () => {
      const resolveChain = createChainMock([]);
      mockDb.select.mockReturnValue(resolveChain as any);

      const result = await listSecretKeys(asInstanceSlug("nonexistent"));

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // deleteSecret
  // -----------------------------------------------------------------------
  describe("deleteSecret", () => {
    it("deletes the secret by instanceId and key", async () => {
      const chain = createChainMock(undefined);
      mockDb.delete.mockReturnValue(chain as any);

      await deleteSecret(INSTANCE_UUID, "openai_api_key");

      expect(mockDb.delete).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
    });
  });
});
