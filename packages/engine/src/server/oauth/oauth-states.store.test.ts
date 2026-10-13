// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one branch of consumeOAuthState a real database cannot reach on demand:
 * a row that expires between the sweep and the delete. Everything else —
 * single use, the sweep, encryption at rest — is exercised against Postgres in
 * oauth-states.store.integration.test.ts.
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
    instanceId: "instance_id",
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
import { consumeOAuthState } from "./oauth-states.store.js";

describe("server/oauth/oauth-states.store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("consumeOAuthState", () => {
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
  });
});
