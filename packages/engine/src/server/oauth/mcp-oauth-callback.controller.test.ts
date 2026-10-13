// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response } from "express";

const mockConsumeOAuthState = vi.fn();
const mockGetMcpServer = vi.fn();
const mockResolveInstanceSlug = vi.fn();
const mockMakeMcpOAuthProvider = vi.fn();
const mockAuth = vi.fn();

vi.mock("./oauth-states.store.js", () => ({
  consumeOAuthState: (...args: unknown[]) => mockConsumeOAuthState(...args),
}));

const mockSaveMcpSharedTokens = vi.fn();
vi.mock("../../instances/mcp-servers.store.js", () => ({
  getMcpServer: (...args: unknown[]) => mockGetMcpServer(...args),
  saveMcpSharedTokens: (...args: unknown[]) => mockSaveMcpSharedTokens(...args),
}));

const mockAuditLog = vi.fn();
vi.mock("../../management-audit/management-audit-logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../management-audit/management-audit-logger.js")>()),
  createManagementAuditLogger: () => ({ log: mockAuditLog }),
}));

vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceSlug: (...args: unknown[]) => mockResolveInstanceSlug(...args),
}));

vi.mock("../../agents/tools/mcp/mcp-oauth-provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/mcp/mcp-oauth-provider.js")>()),
  makeMcpOAuthProvider: (...args: unknown[]) => mockMakeMcpOAuthProvider(...args),
}));

vi.mock("@ai-sdk/mcp", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

import { McpOAuthCallbackController } from "./mcp-oauth-callback.controller.js";

// The platform policies are a row; this suite has no database. The values are
// the shipped defaults, so the assertions read the same as before they moved.
vi.mock("../../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ baseUrl: "http://localhost:4000" }),
}));

const PENDING = { conversationId: "c1", instanceId: "iid", provider: "mcp:gh", codeVerifier: null };
const SERVER = { id: "srv-1", slug: "gh", name: "GitHub", url: "https://mcp.gh.test", authMode: "oauth" as const, enabled: true, config: {} };

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("McpOAuthCallbackController.callback", () => {
  let controller: McpOAuthCallbackController;
  let providerStub: { setStoredState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new McpOAuthCallbackController();
    providerStub = { setStoredState: vi.fn() };
    mockMakeMcpOAuthProvider.mockReturnValue(providerStub);
    mockResolveInstanceSlug.mockResolvedValue("my-instance");
  });

  it("400s when code or state query params are missing", async () => {
    const res = mockResponse();

    await controller.callback(undefined, "state", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockConsumeOAuthState).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("400s when the state nonce is unknown/expired", async () => {
    mockConsumeOAuthState.mockResolvedValue(null);
    const res = mockResponse();

    await controller.callback("code", "bad-state", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("400s when the consumed state's provider is not an mcp: provider", async () => {
    mockConsumeOAuthState.mockResolvedValue({ ...PENDING, provider: "github" });
    const res = mockResponse();

    await controller.callback("code", "state", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetMcpServer).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("404s when the mcp server no longer exists", async () => {
    mockConsumeOAuthState.mockResolvedValue(PENDING);
    mockGetMcpServer.mockResolvedValue(null);
    const res = mockResponse();

    await controller.callback("code", "state", res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("404s when the instance no longer exists (slug resolution fails)", async () => {
    mockConsumeOAuthState.mockResolvedValue(PENDING);
    mockGetMcpServer.mockResolvedValue(SERVER);
    mockResolveInstanceSlug.mockResolvedValue(undefined);
    const res = mockResponse();

    await controller.callback("code", "state", res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockMakeMcpOAuthProvider).not.toHaveBeenCalled();
  });

  it("exchanges the code via auth() and confirms success", async () => {
    mockConsumeOAuthState.mockResolvedValue(PENDING);
    mockGetMcpServer.mockResolvedValue(SERVER);
    mockAuth.mockResolvedValue("AUTHORIZED");
    const res = mockResponse();

    await controller.callback("code-abc", "state-1", res);

    // Defect C: the vault-write side (saveTokens/saveCodeVerifier) must be keyed
    // by the instance SLUG, matching deleteInstance()'s slug-keyed cascade —
    // not the uuid consumed from the oauth_states row.
    expect(mockMakeMcpOAuthProvider).toHaveBeenCalledWith({
      baseUrl: "http://localhost:4000",
      instanceUuid: "iid",
      instanceSlug: "my-instance",
      conversationId: "c1",
      serverSlug: "gh",
      config: SERVER.config,
    });
    expect(providerStub.setStoredState).toHaveBeenCalledWith("state-1");
    expect(mockAuth).toHaveBeenCalledWith(providerStub, {
      serverUrl: SERVER.url,
      authorizationCode: "code-abc",
      callbackState: "state-1",
    });
    expect(res.status).not.toHaveBeenCalled(); // default 200
    expect(res.send).toHaveBeenCalled();
    const sent = (res.send as any).mock.calls[0][0] as string;
    expect(sent).toContain("GitHub");
  });

  it("502s when the token exchange throws", async () => {
    mockConsumeOAuthState.mockResolvedValue(PENDING);
    mockGetMcpServer.mockResolvedValue(SERVER);
    mockAuth.mockRejectedValue(new Error("token exchange failed"));
    const res = mockResponse();

    await controller.callback("code-abc", "state-1", res);

    expect(res.status).toHaveBeenCalledWith(502);
  });

  describe("a shared account an admin started connecting from the panel", () => {
    const ADMIN = "33333333-3333-3333-3333-333333333333";
    const SHARED_PENDING = { conversationId: ADMIN, instanceId: "iid", provider: "mcp-shared:gh", codeVerifier: "pkce-verifier" };
    const SHARED_SERVER = { ...SERVER, config: { account: "shared" } };

    it("stores the tokens on the server for the admin who connected and audits it", async () => {
      mockConsumeOAuthState.mockResolvedValue(SHARED_PENDING);
      mockGetMcpServer.mockResolvedValue(SHARED_SERVER);
      // The exchange as the SDK drives it: read the verifier, save the tokens.
      mockAuth.mockImplementation(async (provider: any) => {
        expect(await provider.codeVerifier()).toBe("pkce-verifier");
        await provider.saveTokens({ access_token: "at-1", token_type: "Bearer" });
        return "AUTHORIZED";
      });
      const res = mockResponse();

      await controller.callback("code-abc", "state-1", res);

      expect(res.status).not.toHaveBeenCalled();
      expect(mockSaveMcpSharedTokens).toHaveBeenCalledWith(
        "iid",
        "gh",
        JSON.stringify({ access_token: "at-1", token_type: "Bearer" }),
        { by: ADMIN },
      );
      expect(mockMakeMcpOAuthProvider).not.toHaveBeenCalled();
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "mcp_server.shared_connect",
          actor: { userId: ADMIN },
          targetId: "gh",
          metadata: { instanceSlug: "my-instance" },
        }),
      );
    });

    it("400s a shared state row that carries no verifier", async () => {
      mockConsumeOAuthState.mockResolvedValue({ ...SHARED_PENDING, codeVerifier: null });
      mockGetMcpServer.mockResolvedValue(SHARED_SERVER);
      const res = mockResponse();

      await controller.callback("code-abc", "state-1", res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockAuth).not.toHaveBeenCalled();
    });

    it("502s and records nothing when the exchange fails", async () => {
      mockConsumeOAuthState.mockResolvedValue(SHARED_PENDING);
      mockGetMcpServer.mockResolvedValue(SHARED_SERVER);
      mockAuth.mockRejectedValue(new Error("invalid_grant"));
      const res = mockResponse();

      await controller.callback("code-abc", "state-1", res);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(mockAuditLog).not.toHaveBeenCalled();
    });
  });
});
