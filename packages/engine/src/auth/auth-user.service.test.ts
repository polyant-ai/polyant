// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeAll } from "vitest";
import { hkdf } from "@panva/hkdf";
import { EncryptJWT } from "jose";

const TEST_SECRET = "test-secret-that-is-at-least-32-characters-long-for-auth";
const WRONG_SECRET = "wrong-secret-that-is-at-least-32-characters-long-nope";

const HTTP_SALT = "authjs.session-token";
const HTTPS_SALT = "__Secure-authjs.session-token";

vi.mock("../config.js", () => ({
  config: {
    auth: { secret: TEST_SECRET },
  },
}));

/**
 * Derives a JWE encryption key the same way Auth.js does internally.
 */
async function deriveKey(secret: string, salt: string): Promise<Uint8Array> {
  return new Uint8Array(
    await hkdf("sha256", secret, salt, `Auth.js Generated Encryption Key (${salt})`, 64),
  );
}

/**
 * Creates a JWE token matching Auth.js format (dir + A256CBC-HS512).
 */
async function createJweToken(
  payload: Record<string, unknown>,
  secret: string,
  salt: string,
  options?: { exp?: number },
): Promise<string> {
  const key = await deriveKey(secret, salt);
  let builder = new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512" })
    .setIssuedAt();

  if (options?.exp) {
    builder = builder.setExpirationTime(options.exp);
  }

  return builder.encrypt(key);
}

// Lazy-import the function under test (after vi.mock is registered)
let validateSessionToken: typeof import("./auth-user.service.js").validateSessionToken;

beforeAll(async () => {
  const mod = await import("./auth-user.service.js");
  validateSessionToken = mod.validateSessionToken;
});

describe("validateSessionToken", () => {
  const userPayload = {
    sub: "user-uuid-123",
    email: "alice@example.com",
    name: "Paolo",
  };

  describe("valid token decryption", () => {
    it("should return user from a valid JWE token (HTTP salt)", async () => {
      const token = await createJweToken(
        { ...userPayload, orgId: "org-uuid-1" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);

      expect(result).toEqual({
        userId: "user-uuid-123",
        email: "alice@example.com",
        name: "Paolo",
        role: "user",
        mustChangePassword: false,
        principalType: "user",
        orgId: "org-uuid-1",
      });
    });

    it("should return user from a valid JWE token (HTTPS salt)", async () => {
      const token = await createJweToken(
        { ...userPayload, orgId: "org-uuid-1" },
        TEST_SECRET,
        HTTPS_SALT,
      );
      const result = await validateSessionToken(token);

      expect(result).toEqual({
        userId: "user-uuid-123",
        email: "alice@example.com",
        name: "Paolo",
        role: "user",
        mustChangePassword: false,
        principalType: "user",
        orgId: "org-uuid-1",
      });
    });

    it("should use sub as userId and fall back to id when sub is missing", async () => {
      const token = await createJweToken(
        { id: "id-fallback-456", email: "test@example.com", orgId: "org-uuid-1" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);

      expect(result).toEqual({
        userId: "id-fallback-456",
        email: "test@example.com",
        name: undefined,
        role: "user",
        mustChangePassword: false,
        principalType: "user",
        orgId: "org-uuid-1",
      });
    });

    it("should propagate role and mustChangePassword from the JWT", async () => {
      const token = await createJweToken(
        { ...userPayload, role: "superadmin", mustChangePassword: true, orgId: "org-uuid-1" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);

      expect(result).toEqual({
        userId: "user-uuid-123",
        email: "alice@example.com",
        name: "Paolo",
        role: "superadmin",
        mustChangePassword: true,
        principalType: "user",
        orgId: "org-uuid-1",
      });
    });
  });

  describe("orgId claim", () => {
    it('should always type principalType as "user" for session tokens', async () => {
      const token = await createJweToken(
        { ...userPayload, orgId: "org-uuid-1" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);
      expect(result!.principalType).toBe("user");
    });

    it("should read orgId from the token when present", async () => {
      const token = await createJweToken(
        { ...userPayload, orgId: "org-abc-789" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);
      expect(result!.orgId).toBe("org-abc-789");
    });

    it("should return undefined orgId when the claim is absent", async () => {
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT);
      const result = await validateSessionToken(token);
      expect(result).not.toBeNull();
      expect(result!.orgId).toBeUndefined();
      expect(result!.principalType).toBe("user");
    });

    it("should ignore a non-string orgId claim", async () => {
      const token = await createJweToken(
        { ...userPayload, orgId: 12345 },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);
      expect(result!.orgId).toBeUndefined();
    });
  });

  describe("both salt variants", () => {
    it("should decrypt token encrypted with HTTP salt without cookieName hint", async () => {
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT);
      const result = await validateSessionToken(token);
      expect(result).not.toBeNull();
      expect(result!.email).toBe("alice@example.com");
    });

    it("should decrypt token encrypted with HTTPS salt without cookieName hint", async () => {
      const token = await createJweToken(userPayload, TEST_SECRET, HTTPS_SALT);
      const result = await validateSessionToken(token);
      expect(result).not.toBeNull();
      expect(result!.email).toBe("alice@example.com");
    });
  });

  describe("cookie name hint", () => {
    it("should try the hinted salt first and succeed on first attempt", async () => {
      const token = await createJweToken(userPayload, TEST_SECRET, HTTPS_SALT);
      const result = await validateSessionToken(token, HTTPS_SALT);

      expect(result).toEqual({
        userId: "user-uuid-123",
        email: "alice@example.com",
        name: "Paolo",
        role: "user",
        mustChangePassword: false,
        principalType: "user",
        orgId: undefined,
      });
    });

    it("should still succeed when cookieName hint does not match encryption salt", async () => {
      // Encrypted with HTTP salt but hinted as HTTPS — should fallback and still work
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT);
      const result = await validateSessionToken(token, HTTPS_SALT);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe("user-uuid-123");
    });

    it("should accept a custom cookie name as hint", async () => {
      const customSalt = "custom-cookie-name";
      const token = await createJweToken(userPayload, TEST_SECRET, customSalt);
      const result = await validateSessionToken(token, customSalt);

      expect(result).toEqual({
        userId: "user-uuid-123",
        email: "alice@example.com",
        name: "Paolo",
        role: "user",
        mustChangePassword: false,
        principalType: "user",
        orgId: undefined,
      });
    });
  });

  describe("wrong secret", () => {
    it("should return null when token was encrypted with a different secret", async () => {
      const token = await createJweToken(userPayload, WRONG_SECRET, HTTP_SALT);
      const result = await validateSessionToken(token);
      expect(result).toBeNull();
    });

    it("should return null when token was encrypted with wrong secret (HTTPS salt)", async () => {
      const token = await createJweToken(userPayload, WRONG_SECRET, HTTPS_SALT);
      const result = await validateSessionToken(token);
      expect(result).toBeNull();
    });
  });

  describe("malformed token", () => {
    it("should return null for a random string", async () => {
      const result = await validateSessionToken("some-random-garbage-string");
      expect(result).toBeNull();
    });

    it("should return null for an empty string", async () => {
      const result = await validateSessionToken("");
      expect(result).toBeNull();
    });

    it("should return null for a dot-separated non-JWE string", async () => {
      const result = await validateSessionToken("not.a.jwt");
      expect(result).toBeNull();
    });

    it("should return null for a five-part dot string that is not valid JWE", async () => {
      const result = await validateSessionToken("a.b.c.d.e");
      expect(result).toBeNull();
    });
  });

  describe("missing claims", () => {
    it("should return null when token has no sub and no email", async () => {
      const token = await createJweToken(
        { name: "No Identity" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);
      expect(result).toBeNull();
    });

    it("should return null when token payload is empty", async () => {
      const token = await createJweToken({}, TEST_SECRET, HTTP_SALT);
      const result = await validateSessionToken(token);
      expect(result).toBeNull();
    });

    it("should return user when only email is present (no sub)", async () => {
      const token = await createJweToken(
        { email: "only-email@example.com" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);
      expect(result).not.toBeNull();
      expect(result!.email).toBe("only-email@example.com");
    });

    it("should return user when only sub is present (no email)", async () => {
      const token = await createJweToken(
        { sub: "sub-only-user" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const result = await validateSessionToken(token);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe("sub-only-user");
    });
  });

  describe("expired token", () => {
    it("should still decrypt a token with exp in the past within clock tolerance", async () => {
      // exp = 10 seconds ago — within the 15s clockTolerance
      const exp = Math.floor(Date.now() / 1000) - 10;
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT, { exp });
      const result = await validateSessionToken(token);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe("user-uuid-123");
    });

    it("should return null for a token expired well beyond clock tolerance", async () => {
      // exp = 5 minutes ago — well beyond the 15s clockTolerance
      const exp = Math.floor(Date.now() / 1000) - 300;
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT, { exp });
      const result = await validateSessionToken(token);
      expect(result).toBeNull();
    });
  });
});
