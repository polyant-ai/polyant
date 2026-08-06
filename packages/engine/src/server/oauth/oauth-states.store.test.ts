// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/server/oauth/oauth-states.store.ts
 *
 * Tests: createOAuthState (encrypts the PKCE verifier), consumeOAuthState
 * (single-use delete-and-return, decrypts the verifier, rejects expired rows,
 * opportunistically sweeps stale rows).
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
  const mockDb = { insert: vi.fn(), delete: vi.fn() };
  const mockEncrypt = vi.fn((v: string) => `encrypted:${v}`);
  const mockDecrypt = vi.fn((v: string) => v.replace("encrypted:", ""));
  return { mockDb, mockEncrypt, mockDecrypt };
});

vi.mock("../../database/client.js", () => ({ db: mockDb }));

vi.mock("../../crypto/index.js", () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
}));

vi.mock("./oauth-states.schema.js", () => ({
  oauthStates: {
    state: "state",
    conversationId: "conversation_id",
    instanceId: "agent_id",
    provider: "provider",
    codeVerifier: "code_verifier",
    expiresAt: "expires_at",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  lt: vi.fn((...args: unknown[]) => ({ type: "lt", args })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { createOAuthState, consumeOAuthState } from "./oauth-states.store.js";

describe("server/oauth/oauth-states.store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createOAuthState", () => {
    it("encrypts a present PKCE verifier before inserting", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await createOAuthState({
        state: "nonce-1",
        conversationId: "conv-1",
        instanceId: "default",
        provider: "google",
        codeVerifier: "verifier-plain",
      });

      expect(mockEncrypt).toHaveBeenCalledWith("verifier-plain");
      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "nonce-1",
          conversationId: "conv-1",
          instanceId: "default",
          provider: "google",
          codeVerifier: "encrypted:verifier-plain",
        }),
      );
    });

    it("leaves a null verifier untouched (no PKCE) and never calls encrypt", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await createOAuthState({
        state: "nonce-2",
        conversationId: "conv-1",
        instanceId: "default",
        provider: "github",
        codeVerifier: null,
      });

      expect(mockEncrypt).not.toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: null }));
    });
  });

  describe("consumeOAuthState", () => {
    it("sweeps expired rows, then deletes and returns + decrypts the matched row", async () => {
      const sweepChain = createChainMock(undefined);
      const future = new Date(Date.now() + 60_000);
      const deleteChain = createChainMock([
        {
          conversationId: "conv-1",
          instanceId: "default",
          provider: "google",
          codeVerifier: "encrypted:verifier-plain",
          expiresAt: future,
        },
      ]);
      mockDb.delete.mockReturnValueOnce(sweepChain as any).mockReturnValueOnce(deleteChain as any);

      const result = await consumeOAuthState("nonce-1");

      expect(mockDb.delete).toHaveBeenCalledTimes(2);
      expect(mockDecrypt).toHaveBeenCalledWith("encrypted:verifier-plain");
      expect(result).toEqual({
        conversationId: "conv-1",
        instanceId: "default",
        provider: "google",
        codeVerifier: "verifier-plain",
      });
    });

    it("returns null and skips decrypt when the nonce is unknown", async () => {
      const sweepChain = createChainMock(undefined);
      const deleteChain = createChainMock([]);
      mockDb.delete.mockReturnValueOnce(sweepChain as any).mockReturnValueOnce(deleteChain as any);

      const result = await consumeOAuthState("unknown-nonce");

      expect(result).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it("returns null for a row that expired between sweep and delete", async () => {
      const sweepChain = createChainMock(undefined);
      const past = new Date(Date.now() - 1);
      const deleteChain = createChainMock([
        {
          conversationId: "conv-1",
          instanceId: "default",
          provider: "google",
          codeVerifier: "encrypted:verifier-plain",
          expiresAt: past,
        },
      ]);
      mockDb.delete.mockReturnValueOnce(sweepChain as any).mockReturnValueOnce(deleteChain as any);

      const result = await consumeOAuthState("nonce-1");

      expect(result).toBeNull();
    });

    it("returns a null codeVerifier untouched (no PKCE for this provider)", async () => {
      const sweepChain = createChainMock(undefined);
      const future = new Date(Date.now() + 60_000);
      const deleteChain = createChainMock([
        {
          conversationId: "conv-1",
          instanceId: "default",
          provider: "github",
          codeVerifier: null,
          expiresAt: future,
        },
      ]);
      mockDb.delete.mockReturnValueOnce(sweepChain as any).mockReturnValueOnce(deleteChain as any);

      const result = await consumeOAuthState("nonce-3");

      expect(result?.codeVerifier).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });
  });
});
