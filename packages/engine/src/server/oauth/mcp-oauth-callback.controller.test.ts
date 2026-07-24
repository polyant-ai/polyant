// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response } from "express";

const mockConsumeOAuthState = vi.fn();
const mockGetMcpServer = vi.fn();
const mockMakeMcpOAuthProvider = vi.fn();
const mockAuth = vi.fn();

vi.mock("./oauth-states.store.js", () => ({
  consumeOAuthState: (...args: unknown[]) => mockConsumeOAuthState(...args),
}));

vi.mock("../../instances/mcp-servers.store.js", () => ({
  getMcpServer: (...args: unknown[]) => mockGetMcpServer(...args),
}));

vi.mock("../../agents/tools/mcp/mcp-oauth-provider.js", () => ({
  makeMcpOAuthProvider: (...args: unknown[]) => mockMakeMcpOAuthProvider(...args),
}));

vi.mock("@ai-sdk/mcp", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

import { McpOAuthCallbackController } from "./mcp-oauth-callback.controller.js";

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

  it("exchanges the code via auth() and confirms success", async () => {
    mockConsumeOAuthState.mockResolvedValue(PENDING);
    mockGetMcpServer.mockResolvedValue(SERVER);
    mockAuth.mockResolvedValue("AUTHORIZED");
    const res = mockResponse();

    await controller.callback("code-abc", "state-1", res);

    expect(mockMakeMcpOAuthProvider).toHaveBeenCalledWith({
      instanceUuid: "iid",
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
});
