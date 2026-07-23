// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetPrincipalSecret = vi.fn();
const mockSetPrincipalSecret = vi.fn();
const mockGetOAuthProvider = vi.fn();
const mockResolveOAuthCredentials = vi.fn();
const mockRefreshAccessToken = vi.fn();

vi.mock("../../conversations/principal-secrets.store.js", () => ({
  getPrincipalSecret: (...args: unknown[]) => mockGetPrincipalSecret(...args),
  setPrincipalSecret: (...args: unknown[]) => mockSetPrincipalSecret(...args),
}));

vi.mock("./oauth-providers.js", () => ({
  getOAuthProvider: (...args: unknown[]) => mockGetOAuthProvider(...args),
  resolveOAuthCredentials: (...args: unknown[]) => mockResolveOAuthCredentials(...args),
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
  oauthTokenStateKey: (provider: string) => `${provider}_oauth_token`,
  oauthRefreshStateKey: (provider: string) => `${provider}_oauth_refresh`,
}));

import { needsRefresh, getValidAccessToken } from "./oauth-token-service.js";

describe("needsRefresh", () => {
  const now = 1_000_000_000_000;
  const skew = 60_000;

  it("should_never_refresh_a_non_expiring_token", () => {
    expect(needsRefresh(null, now, skew)).toBe(false);
  });

  it("should_not_refresh_a_token_valid_beyond_the_skew_window", () => {
    expect(needsRefresh(new Date(now + 2 * skew), now, skew)).toBe(false);
  });

  it("should_refresh_a_token_expiring_within_the_skew_window", () => {
    expect(needsRefresh(new Date(now + skew / 2), now, skew)).toBe(true);
  });

  it("should_refresh_an_already_expired_token", () => {
    expect(needsRefresh(new Date(now - 1), now, skew)).toBe(true);
  });
});

describe("getValidAccessToken", () => {
  const SLUG = "default" as any;
  const CONVERSATION_ID = "conv-1";
  const PROVIDER = { name: "google", authorizeUrl: "https://x", tokenUrl: "https://y", scope: "", extraAuthorizeParams: {}, pkce: true };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there is no stored access token", async () => {
    mockGetPrincipalSecret.mockResolvedValueOnce(undefined);

    const result = await getValidAccessToken(SLUG, CONVERSATION_ID, "google");

    expect(result).toBeNull();
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("returns the stored token directly when it is not near expiry", async () => {
    mockGetPrincipalSecret.mockResolvedValueOnce({ value: "at-valid", expiresAt: new Date(Date.now() + 3_600_000) });

    const result = await getValidAccessToken(SLUG, CONVERSATION_ID, "google");

    expect(result).toBe("at-valid");
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and persists the new access + refresh token", async () => {
    mockGetPrincipalSecret
      .mockResolvedValueOnce({ value: "at-old", expiresAt: new Date(Date.now() - 1) }) // access
      .mockResolvedValueOnce({ value: "rt-old", expiresAt: null }); // refresh
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockRefreshAccessToken.mockResolvedValue({ accessToken: "at-new", refreshToken: "rt-new", expiresIn: 3600 });

    const result = await getValidAccessToken(SLUG, CONVERSATION_ID, "google");

    expect(result).toBe("at-new");
    expect(mockRefreshAccessToken).toHaveBeenCalledWith(PROVIDER, { clientId: "cid", clientSecret: "csecret" }, "rt-old");
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith(CONVERSATION_ID, SLUG, "google_oauth_token", "at-new", expect.any(Date));
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith(CONVERSATION_ID, SLUG, "google_oauth_refresh", "rt-new", null);
  });

  it("does not clobber the stored refresh token when the provider omits one on refresh", async () => {
    mockGetPrincipalSecret
      .mockResolvedValueOnce({ value: "at-old", expiresAt: new Date(Date.now() - 1) })
      .mockResolvedValueOnce({ value: "rt-old", expiresAt: null });
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockRefreshAccessToken.mockResolvedValue({ accessToken: "at-new" });

    const result = await getValidAccessToken(SLUG, CONVERSATION_ID, "google");

    expect(result).toBe("at-new");
    expect(mockSetPrincipalSecret).toHaveBeenCalledTimes(1);
    expect(mockSetPrincipalSecret).toHaveBeenCalledWith(CONVERSATION_ID, SLUG, "google_oauth_token", "at-new", null);
  });

  it("returns null when there is no refresh token to fall back on", async () => {
    mockGetPrincipalSecret
      .mockResolvedValueOnce({ value: "at-old", expiresAt: new Date(Date.now() - 1) })
      .mockResolvedValueOnce(undefined);

    const result = await getValidAccessToken(SLUG, CONVERSATION_ID, "google");

    expect(result).toBeNull();
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  it("returns null when the refresh call fails", async () => {
    mockGetPrincipalSecret
      .mockResolvedValueOnce({ value: "at-old", expiresAt: new Date(Date.now() - 1) })
      .mockResolvedValueOnce({ value: "rt-old", expiresAt: null });
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
    mockRefreshAccessToken.mockRejectedValue(new Error("network error"));

    const result = await getValidAccessToken(SLUG, CONVERSATION_ID, "google");

    expect(result).toBeNull();
    expect(mockSetPrincipalSecret).not.toHaveBeenCalled();
  });

  it("returns null when instance credentials are missing at refresh time", async () => {
    mockGetPrincipalSecret
      .mockResolvedValueOnce({ value: "at-old", expiresAt: new Date(Date.now() - 1) })
      .mockResolvedValueOnce({ value: "rt-old", expiresAt: null });
    mockGetOAuthProvider.mockReturnValue(PROVIDER);
    mockResolveOAuthCredentials.mockResolvedValue({ clientId: undefined, clientSecret: undefined });

    const result = await getValidAccessToken(SLUG, CONVERSATION_ID, "google");

    expect(result).toBeNull();
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });
});
