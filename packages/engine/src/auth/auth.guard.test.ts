// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/auth/auth.guard.ts
 *
 * Tests the global NestJS AuthGuard:
 * - Public routes (with @Public() decorator) bypass the guard.
 * - Bearer token: valid token → user attached, request authorized.
 * - Cookie token: valid `authjs.session-token` → user attached.
 * - Missing token → UnauthorizedException.
 * - Invalid / malformed token → UnauthorizedException.
 * - Expired token → UnauthorizedException.
 *
 * The guard delegates JWE decryption to validateSessionToken() —
 * we generate real JWE tokens with jose to exercise the integration.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { hkdf } from "@panva/hkdf";
import { EncryptJWT } from "jose";

const TEST_SECRET = "test-secret-that-is-at-least-32-characters-long-for-auth";
const HTTP_SALT = "authjs.session-token";
const HTTPS_SALT = "__Secure-authjs.session-token";

vi.mock("../config.js", () => ({
  config: {
    auth: { secret: TEST_SECRET },
  },
}));

// auth.guard now imports findInstanceByAuthApiKey from secrets.store, which
// pulls in database/client.ts. Mock the store to avoid initialising the DB
// at module-eval time — tests that exercise the @AllowInstanceApiKey branch
// can override the mocked return per-case.
vi.mock("../instances/secrets.store.js", () => ({
  findInstanceByAuthApiKey: vi.fn().mockResolvedValue(null),
}));

interface MockRequest {
  headers: Record<string, string | undefined>;
  cookies?: Record<string, string>;
  user?: unknown;
}

async function deriveKey(secret: string, salt: string): Promise<Uint8Array> {
  return new Uint8Array(
    await hkdf("sha256", secret, salt, `Auth.js Generated Encryption Key (${salt})`, 64),
  );
}

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

/** Build a minimal NestJS ExecutionContext from a request. */
function buildExecutionContext(request: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T = MockRequest>() => request as unknown as T,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => () => undefined,
    getClass: () => class TestController {},
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getType: () => "http" as const,
  } as unknown as ExecutionContext;
}

/** Make a Reflector that returns the given value from getAllAndOverride. */
function makeReflector(isPublic: boolean): Reflector {
  return {
    getAllAndOverride: vi.fn(() => isPublic),
  } as unknown as Reflector;
}

let AuthGuard: typeof import("./auth.guard.js").AuthGuard;

beforeAll(async () => {
  const mod = await import("./auth.guard.js");
  AuthGuard = mod.AuthGuard;
});

describe("AuthGuard", () => {
  const userPayload = {
    sub: "user-uuid-123",
    email: "user@example.com",
    name: "Paolo",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Public routes
  // -----------------------------------------------------------------------
  describe("public routes", () => {
    it("should bypass the guard and return true when @Public() is set", async () => {
      const guard = new AuthGuard(makeReflector(true));
      const ctx = buildExecutionContext({ headers: {} });

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
    });

    it("should not attach user to request when route is public", async () => {
      const guard = new AuthGuard(makeReflector(true));
      const request: MockRequest = { headers: {} };
      const ctx = buildExecutionContext(request);

      await guard.canActivate(ctx);

      expect(request.user).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Bearer token (Authorization header)
  // -----------------------------------------------------------------------
  describe("Bearer token", () => {
    it("should return true and attach user when Bearer token is valid", async () => {
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT);
      const guard = new AuthGuard(makeReflector(false));
      const request: MockRequest = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = buildExecutionContext(request);

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(request.user).toEqual({
        userId: "user-uuid-123",
        email: "user@example.com",
        name: "Paolo",
        role: "user",
        mustChangePassword: false,
      });
    });

    it("should throw UnauthorizedException for an invalid (random) Bearer token", async () => {
      const guard = new AuthGuard(makeReflector(false));
      const request: MockRequest = {
        headers: { authorization: "Bearer not-a-valid-jwe-token" },
      };
      const ctx = buildExecutionContext(request);

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  // -----------------------------------------------------------------------
  // Cookie token
  // -----------------------------------------------------------------------
  describe("cookie token", () => {
    it("should return true and attach user when authjs.session-token cookie is valid", async () => {
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT);
      const guard = new AuthGuard(makeReflector(false));
      const request: MockRequest = {
        headers: {},
        cookies: { "authjs.session-token": token },
      };
      const ctx = buildExecutionContext(request);

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(request.user).toEqual({
        userId: "user-uuid-123",
        email: "user@example.com",
        name: "Paolo",
        role: "user",
        mustChangePassword: false,
      });
    });

    it("should accept __Secure-authjs.session-token cookie variant (HTTPS prod cookie)", async () => {
      const token = await createJweToken(userPayload, TEST_SECRET, HTTPS_SALT);
      const guard = new AuthGuard(makeReflector(false));
      const request: MockRequest = {
        headers: {},
        cookies: { "__Secure-authjs.session-token": token },
      };
      const ctx = buildExecutionContext(request);

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect((request.user as { email: string }).email).toBe("user@example.com");
    });

    it("should prefer Authorization header over cookie when both are present", async () => {
      const bearerToken = await createJweToken(
        { sub: "from-bearer", email: "bearer@example.com" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const cookieToken = await createJweToken(
        { sub: "from-cookie", email: "cookie@example.com" },
        TEST_SECRET,
        HTTP_SALT,
      );
      const guard = new AuthGuard(makeReflector(false));
      const request: MockRequest = {
        headers: { authorization: `Bearer ${bearerToken}` },
        cookies: { "authjs.session-token": cookieToken },
      };
      const ctx = buildExecutionContext(request);

      await guard.canActivate(ctx);

      expect((request.user as { userId: string }).userId).toBe("from-bearer");
    });
  });

  // -----------------------------------------------------------------------
  // Missing token
  // -----------------------------------------------------------------------
  describe("missing token", () => {
    it("should throw UnauthorizedException when no header and no cookie are present", async () => {
      const guard = new AuthGuard(makeReflector(false));
      const ctx = buildExecutionContext({ headers: {} });

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(ctx)).rejects.toThrow("Missing authentication");
    });

    it("should throw UnauthorizedException when Authorization header is not Bearer", async () => {
      const guard = new AuthGuard(makeReflector(false));
      const ctx = buildExecutionContext({
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  // -----------------------------------------------------------------------
  // Expired token
  // -----------------------------------------------------------------------
  describe("expired token", () => {
    it("should throw UnauthorizedException for a token expired beyond clock tolerance", async () => {
      // 5 minutes in the past — well beyond 15s clockTolerance
      const exp = Math.floor(Date.now() / 1000) - 300;
      const token = await createJweToken(userPayload, TEST_SECRET, HTTP_SALT, { exp });
      const guard = new AuthGuard(makeReflector(false));
      const ctx = buildExecutionContext({
        headers: { authorization: `Bearer ${token}` },
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(ctx)).rejects.toThrow("Invalid or expired session");
    });
  });

  // -----------------------------------------------------------------------
  // Invalid claims
  // -----------------------------------------------------------------------
  describe("invalid claims", () => {
    it("should throw UnauthorizedException when token has neither sub nor email", async () => {
      const token = await createJweToken({ name: "Anonymous" }, TEST_SECRET, HTTP_SALT);
      const guard = new AuthGuard(makeReflector(false));
      const ctx = buildExecutionContext({
        headers: { authorization: `Bearer ${token}` },
      });

      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });
});
