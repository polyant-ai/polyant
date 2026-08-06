// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/conversations/principal-secrets.store.ts
 *
 * Tests: setPrincipalSecret, getPrincipalSecret, deletePrincipalSecret,
 * listPrincipalSecretKeys — the encrypted per-conversation OAuth token vault.
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

vi.mock("./principal-secrets.schema.js", () => ({
  principalSecrets: {
    scope: "scope",
    scopeKey: "scope_key",
    instanceId: "agent_id",
    key: "key",
    value: "value",
    expiresAt: "expires_at",
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
  setPrincipalSecret,
  getPrincipalSecret,
  deletePrincipalSecret,
  listPrincipalSecretKeys,
} from "./principal-secrets.store.js";

const CONVERSATION_ID = "conv-123";
const INSTANCE_SLUG = "default";

describe("conversations/principal-secrets.store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("setPrincipalSecret", () => {
    it("encrypts the value and upserts scoped to conversation", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await setPrincipalSecret(CONVERSATION_ID, INSTANCE_SLUG, "github_oauth_token", "gho_real-token", null);

      expect(mockEncrypt).toHaveBeenCalledWith("gho_real-token");
      expect(chain.values).toHaveBeenCalledWith({
        scope: "conversation",
        scopeKey: CONVERSATION_ID,
        instanceId: INSTANCE_SLUG,
        key: "github_oauth_token",
        value: "encrypted:gho_real-token",
        expiresAt: null,
      });
      expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it("passes expiresAt through to the upsert", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);
      const expiresAt = new Date("2026-08-01T00:00:00Z");

      await setPrincipalSecret(CONVERSATION_ID, INSTANCE_SLUG, "google_oauth_token", "ya29.token", expiresAt);

      expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }));
    });
  });

  describe("getPrincipalSecret", () => {
    it("fetches and decrypts the secret with its expiry", async () => {
      const expiresAt = new Date("2026-08-01T00:00:00Z");
      const chain = createChainMock([{ value: "encrypted:gho_real-token", expiresAt }]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await getPrincipalSecret(CONVERSATION_ID, "github_oauth_token");

      expect(result).toEqual({ value: "gho_real-token", expiresAt });
      expect(mockDecrypt).toHaveBeenCalledWith("encrypted:gho_real-token");
    });

    it("returns undefined when no row exists", async () => {
      const chain = createChainMock([]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await getPrincipalSecret(CONVERSATION_ID, "github_oauth_token");

      expect(result).toBeUndefined();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });
  });

  describe("deletePrincipalSecret", () => {
    it("deletes the secret scoped to conversation + key", async () => {
      const chain = createChainMock(undefined);
      mockDb.delete.mockReturnValue(chain as any);

      await deletePrincipalSecret(CONVERSATION_ID, "github_oauth_token");

      expect(mockDb.delete).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
    });
  });

  describe("listPrincipalSecretKeys", () => {
    it("returns keys + expiry, never the decrypted value", async () => {
      const chain = createChainMock([
        { key: "github_oauth_token", expiresAt: null },
        { key: "google_oauth_token", expiresAt: new Date("2026-08-01T00:00:00Z") },
      ]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await listPrincipalSecretKeys(CONVERSATION_ID);

      expect(result).toEqual([
        { key: "github_oauth_token", expiresAt: null },
        { key: "google_oauth_token", expiresAt: new Date("2026-08-01T00:00:00Z") },
      ]);
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("returns empty array when no secrets exist", async () => {
      const chain = createChainMock([]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await listPrincipalSecretKeys(CONVERSATION_ID);

      expect(result).toEqual([]);
    });
  });
});
