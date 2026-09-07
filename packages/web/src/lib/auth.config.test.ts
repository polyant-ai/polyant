// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for the Edge `authorized` callback — specifically that an
 * unauthenticated deep link keeps its query string in `callbackUrl`. That is
 * the path a bookmarked tenant-scoped conversation actually takes.
 *
 * Also covers the `jwt` callback's handling of `isPlatformAdmin`: it is set
 * from the credentials `authorize()` result at sign-in, defaults to `false`
 * for a Google sign-in (no such field on the user object), and — the most
 * important case here — can NEVER be elevated by a client `update()` patch.
 */

import { describe, it, expect } from "vitest";
import { authConfig } from "./auth.config";

type AuthorizedFn = (params: {
  auth: { user?: unknown } | null;
  request: { nextUrl: URL };
}) => unknown;

const authorized = authConfig.callbacks?.authorized as unknown as AuthorizedFn;

interface FakeToken {
  id?: string;
  isPlatformAdmin?: boolean;
  mustChangePassword?: boolean;
  orgId?: string;
}

type JwtFn = (params: {
  token: FakeToken;
  user?: Record<string, unknown>;
  trigger?: "signIn" | "signUp" | "update";
  session?: unknown;
}) => FakeToken | Promise<FakeToken>;

const jwt = authConfig.callbacks?.jwt as unknown as JwtFn;

function visitAnonymously(url: string): Response {
  const result = authorized({
    auth: null,
    request: { nextUrl: new URL(url, "https://admin.test") },
  });
  return result as Response;
}

function callbackUrlOf(response: Response): string | null {
  const location = response.headers.get("location");
  return location ? new URL(location).searchParams.get("callbackUrl") : null;
}

describe("authConfig.authorized", () => {
  it("preserves the query string of an anonymous deep link", () => {
    const response = visitAnonymously(
      "/organizations/default/workspaces/default/conversations?id=abc&tab=steps",
    );

    expect(callbackUrlOf(response)).toBe(
      "/organizations/default/workspaces/default/conversations?id=abc&tab=steps",
    );
  });

  it("sends a bare path through unchanged", () => {
    const response = visitAnonymously(
      "/organizations/default/workspaces/default/instances",
    );

    expect(callbackUrlOf(response)).toBe(
      "/organizations/default/workspaces/default/instances",
    );
  });

  it("redirects an anonymous visitor to the login page", () => {
    const response = visitAnonymously(
      "/organizations/default/workspaces/default/instances",
    );

    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("authConfig.jwt — isPlatformAdmin", () => {
  it("elevates the token when the credentials user carries the flag", async () => {
    const token = await jwt({
      token: {},
      user: { id: "u1", isPlatformAdmin: true, mustChangePassword: false },
      trigger: "signIn",
    });

    expect(token.isPlatformAdmin).toBe(true);
  });

  it("does not elevate a plain user carrying the flag as false", async () => {
    const token = await jwt({
      token: {},
      user: { id: "u1", isPlatformAdmin: false, mustChangePassword: false },
      trigger: "signIn",
    });

    expect(token.isPlatformAdmin).toBe(false);
  });

  it("defaults to false for a Google sign-in (no isPlatformAdmin on the user object)", async () => {
    const token = await jwt({
      token: {},
      user: { id: "u1", email: "ada@example.com" },
      trigger: "signIn",
    });

    expect(token.isPlatformAdmin).toBe(false);
  });

  // The security-critical case: a client `useSession().update({...})` patch
  // must never be able to grant platform-admin standing. Trusting a
  // client-supplied flag here would let any authenticated user become a
  // platform admin by POSTing {isPlatformAdmin: true} to `/api/auth/session`.
  it("never elevates isPlatformAdmin from a client update() patch", async () => {
    const existingToken: FakeToken = { id: "u1", isPlatformAdmin: false };

    const token = await jwt({
      token: existingToken,
      trigger: "update",
      session: { isPlatformAdmin: true },
    });

    expect(token.isPlatformAdmin).toBe(false);
  });

  it("lets an update() patch still refresh mustChangePassword", async () => {
    const existingToken: FakeToken = {
      id: "u1",
      isPlatformAdmin: false,
      mustChangePassword: true,
    };

    const token = await jwt({
      token: existingToken,
      trigger: "update",
      session: { mustChangePassword: false, isPlatformAdmin: true },
    });

    expect(token.mustChangePassword).toBe(false);
    // Same patch, but the isPlatformAdmin half of it must still be ignored.
    expect(token.isPlatformAdmin).toBe(false);
  });
});
