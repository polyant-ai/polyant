// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Response } from "express";

const mockGetOAuthProvider = vi.fn();
const mockHasOAuthProvider = vi.fn();
const mockExchangeCodeForToken = vi.fn();
const mockResolveOAuthCredentials = vi.fn();
const mockConsumeOAuthState = vi.fn();
const mockSetPrincipalSecret = vi.fn();

vi.mock("./oauth-providers.js", () => ({
  getOAuthProvider: (...args: unknown[]) => mockGetOAuthProvider(...args),
  hasOAuthProvider: (...args: unknown[]) => mockHasOAuthProvider(...args),
  exchangeCodeForToken: (...args: unknown[]) => mockExchangeCodeForToken(...args),
  resolveOAuthCredentials: (...args: unknown[]) => mockResolveOAuthCredentials(...args),
  oauthTokenStateKey: (provider: string, scope?: string | null) => `${scope ? `${scope}:` : ""}${provider}_oauth_token`,
  oauthRefreshStateKey: (provider: string, scope?: string | null) => `${scope ? `${scope}:` : ""}${provider}_oauth_refresh`,
}));

vi.mock("./oauth-states.store.js", () => ({
  consumeOAuthState: (...args: unknown[]) => mockConsumeOAuthState(...args),
}));

vi.mock("../../conversations/principal-secrets.store.js", () => ({
  setPrincipalSecret: (...args: unknown[]) => mockSetPrincipalSecret(...args),
}));

import { OAuthCallbackController } from "./oauth-callback.controller.js";
import { resetOAuthAuthorizationScopes, setOAuthAuthorizationScopes } from "./oauth-authorization-scopes.port.js";

const PROVIDER = { name: "github", authorizeUrl: "https://x", tokenUrl: "https://y", scope: "", extraAuthorizeParams: {}, pkce: false };

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("OAuthCallbackController.callback", () => {
  let controller: OAuthCallbackController;

  beforeEach(() => {
    vi.clearAllMocks();
    // By default a name is known exactly when the shared registry holds it.
    mockHasOAuthProvider.mockImplementation((name: string) => mockGetOAuthProvider(name) !== undefined);
    controller = new OAuthCallbackController();
  });

  afterEach(() => resetOAuthAuthorizationScopes());

  it("404s on an unknown provider and HTML-escapes the reflected path segment (XSS guard)", async () => {
    mockGetOAuthProvider.mockReturnValue(undefined);
    const res = mockResponse();

    await controller.callback('<img src=x onerror=alert(1)>', "code", "state", res);

    expect(res.status).toHaveBeenCalledWith(404);
    const sent = (res.send as any).mock.calls[0][0] as string;
    expect(sent).not.toContain("<img");
    expect(sent).toContain("&lt;img");
  });

  it("400s when code or state query params are missing", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    const res = mockResponse();

    await controller.callback("github", undefined, "state", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockConsumeOAuthState).not.toHaveBeenCalled();
  });

  it("400s when the state nonce is unknown/expired", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockConsumeOAuthState.mockResolvedValue(null);
    const res = mockResponse();

    await controller.callback("github", "code", "bad-state", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("400s when the state's provider does not match the path provider", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1",
      instanceId: "default",
      provider: "google",
      codeVerifier: null,
    });
    const res = mockResponse();

    await controller.callback("github", "code", "state", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("400s when instance credentials are not configured", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1",
      instanceId: "default",
      provider: "github",
      codeVerifier: null,
    });
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: undefined, clientSecret: undefined });
    const res = mockResponse();

    await controller.callback("github", "code", "state", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("exchanges the code, stores access + refresh token in the vault, and confirms success", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1",
      instanceId: "default",
      provider: "github",
      codeVerifier: "verifier-1",
    });
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockExchangeCodeForToken.mockResolvedValue({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    const res = mockResponse();

    await controller.callback("github", "code-abc", "state-1", res);

    expect(mockExchangeCodeForToken).toHaveBeenCalledWith(
      PROVIDER,
      "code-abc",
      { clientId: "cid", clientSecret: "csecret" },
      "verifier-1",
    );
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith(
      "conv-1",
      "default",
      "github_oauth_token",
      "at-1",
      expect.any(Date),
    );
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith("conv-1", "default", "github_oauth_refresh", "rt-1", null);
    expect(res.status).not.toHaveBeenCalled(); // default 200
    expect(res.send).toHaveBeenCalled();
  });

  it("does not persist a refresh token when the provider didn't issue one", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1",
      instanceId: "default",
      provider: "github",
      codeVerifier: null,
    });
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockExchangeCodeForToken.mockResolvedValue({ accessToken: "at-1" });
    const res = mockResponse();

    await controller.callback("github", "code-abc", "state-1", res);

    expect(mockSetPrincipalSecret).toHaveBeenCalledTimes(1);
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith("conv-1", "default", "github_oauth_token", "at-1", null);
  });

  it("reads the shared registry and the bare keys when no scope store is registered", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1", instanceId: "default", provider: "github", codeVerifier: null,
    });
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockExchangeCodeForToken.mockResolvedValue({ accessToken: "at-1" });

    await controller.callback("github", "code-abc", "state-1", mockResponse());

    expect(mockGetOAuthProvider).toHaveBeenLastCalledWith("github", null);
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith("conv-1", "default", "github_oauth_token", "at-1", null);
  });

  it("completes a scoped authorization with its scope's provider and keys, never the shared one of the same name", async () => {
    const scoped = { ...PROVIDER, tokenUrl: "https://scoped.example/token" };
    mockGetOAuthProvider.mockImplementation((_name: string, scope?: string | null) => (scope === "scope-a" ? scoped : PROVIDER));
    setOAuthAuthorizationScopes({
      remember: async () => {},
      scopeOf: async (state) => (state === "state-1" ? "scope-a" : null),
    });
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1", instanceId: "default", provider: "github", codeVerifier: null,
    });
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockExchangeCodeForToken.mockResolvedValue({ accessToken: "at-1", refreshToken: "rt-1" });

    await controller.callback("github", "code-abc", "state-1", mockResponse());

    expect(mockExchangeCodeForToken).toHaveBeenCalledWith(scoped, "code-abc", expect.anything(), null);
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith("conv-1", "default", "scope-a:github_oauth_token", "at-1", null);
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith("conv-1", "default", "scope-a:github_oauth_refresh", "rt-1", null);
  });

  it("lets a name held only in a scoped registry reach the state, and 404s when the authorization's scope lacks it", async () => {
    mockGetOAuthProvider.mockReturnValue(undefined);
    mockHasOAuthProvider.mockReturnValue(true);
    setOAuthAuthorizationScopes({ remember: async () => {}, scopeOf: async () => "scope-b" });
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1", instanceId: "default", provider: "github", codeVerifier: null,
    });
    const res = mockResponse();

    await controller.callback("github", "code-abc", "state-1", res);

    expect(mockConsumeOAuthState).toHaveBeenCalledWith("state-1");
    expect(mockGetOAuthProvider).toHaveBeenCalledWith("github", "scope-b");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("502s when the token exchange throws", async () => {
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockConsumeOAuthState.mockResolvedValue({
      conversationId: "conv-1",
      instanceId: "default",
      provider: "github",
      codeVerifier: null,
    });
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockExchangeCodeForToken.mockRejectedValue(new Error("github token endpoint returned 400"));
    const res = mockResponse();

    await controller.callback("github", "code-abc", "state-1", res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockSetPrincipalSecret).not.toHaveBeenCalled();
  });
});
