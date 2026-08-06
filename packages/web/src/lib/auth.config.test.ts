// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for the Edge `authorized` callback — specifically that an
 * unauthenticated deep link keeps its query string in `callbackUrl`. That is
 * the path a bookmarked tenant-scoped conversation actually takes.
 */

import { describe, it, expect } from "vitest";
import { authConfig } from "./auth.config";

type AuthorizedFn = (params: {
  auth: { user?: unknown } | null;
  request: { nextUrl: URL };
}) => unknown;

const authorized = authConfig.callbacks?.authorized as unknown as AuthorizedFn;

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
      "/organizations/default/workspaces/default/agents",
    );

    expect(callbackUrlOf(response)).toBe(
      "/organizations/default/workspaces/default/agents",
    );
  });

  it("redirects an anonymous visitor to the login page", () => {
    const response = visitAnonymously(
      "/organizations/default/workspaces/default/agents",
    );

    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });
});
