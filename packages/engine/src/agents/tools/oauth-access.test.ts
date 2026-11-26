// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateOAuthState = vi.fn();
const mockGetValidAccessToken = vi.fn();

vi.mock("../../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ baseUrl: "http://localhost:4000" }),
}));
vi.mock("../../server/oauth/oauth-states.store.js", () => ({
  createOAuthState: (...args: unknown[]) => mockCreateOAuthState(...args),
}));
vi.mock("../../server/oauth/oauth-token-service.js", () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
}));

import { makeOAuthAccess, oauthConnectResult } from "./oauth-access.js";
import { registerOAuthProvider, _resetOAuthRegistryForTests, type OAuthProvider } from "../../server/oauth/oauth-providers.js";
import {
  getOAuthAuthorizationScopes,
  resetOAuthAuthorizationScopes,
  setOAuthAuthorizationScopes,
} from "../../server/oauth/oauth-authorization-scopes.port.js";
import type { ToolContext } from "./registry.js";

const provider = (authorizeUrl: string): OAuthProvider => ({
  name: "github", authorizeUrl, tokenUrl: `${authorizeUrl}/token`, scope: "repo", extraAuthorizeParams: {}, pkce: false,
});

const ctx = {
  instanceId: "agent",
  conversationId: "conv-1",
  secrets: { github_oauth_client_id: "cid" },
} as unknown as ToolContext;

beforeEach(() => {
  vi.clearAllMocks();
  _resetOAuthRegistryForTests();
  registerOAuthProvider(provider("https://shared.example/authorize"));
  registerOAuthProvider(provider("https://scoped.example/authorize"), "scope-a");
});

afterEach(() => resetOAuthAuthorizationScopes());

describe("OAuth provider scope seam", () => {
  it("answers no scope by default, and refuses to remember one it could not hand back", async () => {
    expect(await getOAuthAuthorizationScopes().scopeOf("any-state")).toBeNull();
    await expect(getOAuthAuthorizationScopes().remember("any-state", "scope-a")).rejects.toThrow(/No OAuth authorization scope store/);
  });

  it("builds the link from the shared registry and records no scope when the tool has none", async () => {
    const remember = vi.fn();
    setOAuthAuthorizationScopes({ remember, scopeOf: async () => null });

    const result = await oauthConnectResult(ctx, "github");

    expect(String(result.url)).toMatch(/^https:\/\/shared\.example\/authorize\?/);
    expect(mockCreateOAuthState).toHaveBeenCalledOnce();
    expect(remember).not.toHaveBeenCalled();
  });

  it("builds a scoped tool's link from its registry and records the scope under the same state", async () => {
    const remember = vi.fn();
    setOAuthAuthorizationScopes({ remember, scopeOf: async () => null });

    const result = await oauthConnectResult(ctx, "github", "scope-a");

    expect(String(result.url)).toMatch(/^https:\/\/scoped\.example\/authorize\?/);
    const { state } = mockCreateOAuthState.mock.calls[0]![0] as { state: string };
    expect(remember).toHaveBeenCalledWith(state, "scope-a");
    expect(String(result.url)).toContain(`state=${state}`);
  });

  it("does not hand out a scoped link when no scope store is registered", async () => {
    await expect(oauthConnectResult(ctx, "github", "scope-a")).rejects.toThrow(/No OAuth authorization scope store/);
  });

  it("gives no link for a scope that lacks the provider, even when the shared registry has it", async () => {
    const result = await oauthConnectResult(ctx, "github", "scope-b");

    expect(result).toHaveProperty("error");
    expect(mockCreateOAuthState).not.toHaveBeenCalled();
  });

  it("binds ctx.oauth to the tool's scope for the token and the link", async () => {
    setOAuthAuthorizationScopes({ remember: vi.fn(), scopeOf: async () => null });
    mockGetValidAccessToken.mockResolvedValue(null);

    const result = await makeOAuthAccess(ctx, "scope-a").requireToken("github");

    expect(mockGetValidAccessToken).toHaveBeenCalledWith("agent", "conv-1", "github", "scope-a");
    expect(result.ok).toBe(false);
    expect(String((result as { result: Record<string, unknown> }).result.url)).toMatch(/^https:\/\/scoped\.example\//);
  });

  it("keeps ctx.oauth on the shared registry by default", async () => {
    mockGetValidAccessToken.mockResolvedValue("at-1");

    const result = await makeOAuthAccess(ctx).requireToken("github");

    expect(mockGetValidAccessToken).toHaveBeenCalledWith("agent", "conv-1", "github", null);
    expect(result).toEqual({ ok: true, token: "at-1" });
  });
});
