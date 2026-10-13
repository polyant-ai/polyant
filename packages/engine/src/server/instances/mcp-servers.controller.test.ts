// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ZodError } from "zod";

const store = {
  setMcpServer: vi.fn(),
  getMcpServer: vi.fn(),
  listMcpServers: vi.fn(),
  deleteMcpServer: vi.fn(),
  mcpServerConfigSchema: vi.fn(() => ({})),
  clearMcpSharedTokens: vi.fn(),
  getMcpSharedTokens: vi.fn(),
  saveMcpSharedTokens: vi.fn(),
};
vi.mock("../../instances/mcp-servers.store.js", () => ({
  ...store,
  usesSharedAccount: (authMode: string, config: { account?: string }) => authMode === "oauth" && config.account === "shared",
  MCP_AUTH_MODES: ["static", "oauth"],
}));
const createOAuthState = vi.fn();
vi.mock("../oauth/oauth-states.store.js", () => ({ createOAuthState }));
vi.mock("../../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ baseUrl: "https://polyant.test" }),
}));
// The provider's half of an authorization start, as `auth()` drives it: a
// state nonce, the PKCE verifier, then the redirect to the authorize URL.
const sdkAuth = vi.fn(async (provider: any) => {
  await provider.saveState(await provider.state());
  await provider.saveCodeVerifier("pkce-verifier");
  await provider.redirectToAuthorization(new URL("https://idp.test/authorize?client_id=c1"));
  return "REDIRECT";
});
vi.mock("@ai-sdk/mcp", () => ({ auth: sdkAuth }));
vi.mock("./instance-helpers.js", () => ({
  findInstanceOrFail: vi.fn(async () => ({ id: "uuid-1", slug: "acme" })),
}));
const auditLog = vi.fn();
vi.mock("../../management-audit/management-audit-logger.js", () => ({
  createManagementAuditLogger: () => ({ log: auditLog }),
  ManagementAuditAction: {
    McpServerWrite: "mcp_server.write",
    McpServerDelete: "mcp_server.delete",
    McpServerSharedDisconnect: "mcp_server.shared_disconnect",
  },
  ManagementAuditTarget: { McpServer: "mcp_server" },
  toManagementAuditActor: () => undefined,
}));
vi.mock("../../agents/tools/mcp/mcp-test.js", () => ({
  testMcpConnection: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../agents/tools/mcp/mcp-url-guard.js", () => ({
  assertSafeMcpUrl: vi.fn(),
}));

// mcp-config-mask.js is NOT mocked — the real maskMcpConfig/mergeMaskedMcpSecrets
// helpers run so the masking/preservation behavior is actually verified.

const { McpServersController } = await import("./mcp-servers.controller.js");

describe("McpServersController", () => {
  beforeEach(() => {
    Object.values(store).forEach((f) => f.mockReset());
    createOAuthState.mockReset();
    auditLog.mockReset();
  });

  describe("the agent's shared account", () => {
    const sharedServer = {
      id: "row-1",
      slug: "linear",
      name: "Linear",
      url: "https://mcp.linear.test/mcp",
      authMode: "oauth",
      enabled: true,
      config: { account: "shared" },
    };
    const admin = { userId: "33333333-3333-3333-3333-333333333333", email: "a@x.test" } as any;

    it("starts a connection: returns the authorize URL and files the verifier under the admin", async () => {
      store.getMcpServer.mockResolvedValue(sharedServer);
      const c = new McpServersController();

      const out = await c.connectShared("acme", "linear", admin);

      expect(out).toEqual({ authorizeUrl: "https://idp.test/authorize?client_id=c1" });
      expect(createOAuthState).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "mcp-shared:linear",
          conversationId: admin.userId,
          instanceId: "uuid-1",
          codeVerifier: "pkce-verifier",
        }),
      );
    });

    it("refuses a server that asks each conversation to authorize", async () => {
      store.getMcpServer.mockResolvedValue({ ...sharedServer, config: {} });
      const c = new McpServersController();
      await expect(c.connectShared("acme", "linear", admin)).rejects.toBeInstanceOf(BadRequestException);
      expect(createOAuthState).not.toHaveBeenCalled();
    });

    it("disconnects and audits only when an account was connected", async () => {
      const c = new McpServersController();

      store.clearMcpSharedTokens.mockResolvedValueOnce(true);
      await expect(c.disconnectShared("acme", "linear", admin)).resolves.toEqual({ disconnected: true });
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "mcp_server.shared_disconnect", targetId: "linear" }),
      );

      auditLog.mockReset();
      store.clearMcpSharedTokens.mockResolvedValueOnce(false);
      await expect(c.disconnectShared("acme", "linear", admin)).resolves.toEqual({ disconnected: false });
      expect(auditLog).not.toHaveBeenCalled();
    });
  });

  it("should_mask_tokens_in_list_response", async () => {
    store.listMcpServers.mockResolvedValue([
      { slug: "gh", name: "GH", url: "u", authMode: "static", enabled: true, config: { auth: { type: "bearer", token: "sh-real-secret" } } },
      { slug: "oa", name: "OA", url: "u2", authMode: "oauth", enabled: true, config: { staticClient: { clientId: "id1", clientSecret: "oauth-client-secret" } } },
    ]);
    const c = new McpServersController();
    const out = await c.list("acme");

    expect(store.listMcpServers).toHaveBeenCalledWith("uuid-1");
    expect(out).toHaveLength(2);

    const staticServer = out.find((s: any) => s.slug === "gh") as any;
    expect(staticServer.config.auth.token).toMatch(/^••••/);
    expect(staticServer.config.auth.token).not.toBe("sh-real-secret");

    const oauthServer = out.find((s: any) => s.slug === "oa") as any;
    expect(oauthServer.config.staticClient.clientSecret).toMatch(/^••••/);
    expect(oauthServer.config.staticClient.clientSecret).not.toBe("oauth-client-secret");
  });

  it("should_reject_invalid_body", async () => {
    const c = new McpServersController();
    await expect(c.set("acme", "gh", { name: "", url: "", authMode: "static", enabled: true, config: {} } as any)).rejects.toThrow();
  });

  it("should_preserve_existing_secret_when_masked_value_resubmitted", async () => {
    store.getMcpServer.mockResolvedValue({
      id: "row-1",
      slug: "gh",
      name: "GH",
      url: "https://mcp.example.com",
      authMode: "static",
      enabled: true,
      config: { auth: { type: "bearer", token: "real-secret-1234" } },
    });
    const c = new McpServersController();

    await c.set("acme", "gh", {
      name: "GH",
      url: "https://mcp.example.com",
      authMode: "static",
      enabled: true,
      config: { auth: { type: "bearer", token: "••••1234" } },
    } as any);

    expect(store.setMcpServer).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        config: { auth: { type: "bearer", token: "real-secret-1234" } },
      }),
    );
  });

  it("should_throw_bad_request_on_semantically_invalid_config", async () => {
    store.getMcpServer.mockResolvedValue(null);
    store.mcpServerConfigSchema.mockImplementationOnce(() => {
      throw new ZodError([{ code: "invalid_type", expected: "object", path: ["auth"], message: "Required" } as any]);
    });
    const c = new McpServersController();

    await expect(
      c.set("acme", "gh", { name: "GH", url: "https://mcp.example.com", authMode: "static", enabled: true, config: {} } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.setMcpServer).not.toHaveBeenCalled();
  });

  it("should_restore_stored_secret_when_testing_an_existing_server_with_a_masked_token", async () => {
    store.getMcpServer.mockResolvedValue({
      id: "row-1",
      slug: "gh",
      name: "GH",
      url: "https://mcp.example.com",
      authMode: "static",
      enabled: true,
      config: { auth: { type: "bearer", token: "real-secret-1234" } },
    });
    const c = new McpServersController();

    await c.test("acme", {
      slug: "gh",
      name: "GH",
      url: "https://mcp.example.com",
      authMode: "static",
      enabled: true,
      config: { auth: { type: "bearer", token: "••••1234" } },
    } as any);

    expect(store.getMcpServer).toHaveBeenCalledWith("uuid-1", "gh");
    const { testMcpConnection } = await import("../../agents/tools/mcp/mcp-test.js");
    expect(testMcpConnection).toHaveBeenCalledWith(
      expect.objectContaining({ config: { auth: { type: "bearer", token: "real-secret-1234" } } }),
    );
  });

  // The stored token belongs to the server it was entered for. Moving the URL to
  // another host while echoing the mask used to send that token to the new host,
  // on save and on test — reachable by a role that may edit MCP servers but
  // never read their secrets.
  describe("when the server's address moves to another origin", () => {
    const stored = {
      id: "row-1",
      slug: "gh",
      name: "GH",
      url: "https://mcp.example.com",
      authMode: "static",
      enabled: true,
      config: { auth: { type: "bearer", token: "real-secret-1234" } },
    };
    const moved = {
      name: "GH",
      url: "https://collector.attacker.test",
      authMode: "static",
      enabled: true,
      config: { auth: { type: "bearer", token: "••••1234" } },
    };

    it("refuses to save it with the stored token", async () => {
      store.getMcpServer.mockResolvedValue(stored);
      const c = new McpServersController();

      await expect(c.set("acme", "gh", moved as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(store.setMcpServer).not.toHaveBeenCalled();
    });

    it("refuses to test it with the stored token", async () => {
      store.getMcpServer.mockResolvedValue(stored);
      const { testMcpConnection } = await import("../../agents/tools/mcp/mcp-test.js");
      vi.mocked(testMcpConnection).mockClear();
      const c = new McpServersController();

      await expect(c.test("acme", { slug: "gh", ...moved } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(testMcpConnection).not.toHaveBeenCalled();
    });

    it("accepts it when the token is entered again", async () => {
      store.getMcpServer.mockResolvedValue(stored);
      const c = new McpServersController();

      await c.set("acme", "gh", { ...moved, config: { auth: { type: "bearer", token: "new-token" } } } as any);
      expect(store.setMcpServer).toHaveBeenCalledWith(
        "uuid-1",
        expect.objectContaining({ config: { auth: { type: "bearer", token: "new-token" } } }),
      );
    });
  });

  it("should_skip_the_secret_merge_when_testing_a_brand_new_unsaved_server", async () => {
    const c = new McpServersController();

    await c.test("acme", {
      name: "New server",
      url: "https://mcp.example.com",
      authMode: "static",
      enabled: true,
      config: { auth: { type: "bearer", token: "fresh-token" } },
    } as any);

    expect(store.getMcpServer).not.toHaveBeenCalled();
    const { testMcpConnection } = await import("../../agents/tools/mcp/mcp-test.js");
    expect(testMcpConnection).toHaveBeenCalledWith(
      expect.objectContaining({ config: { auth: { type: "bearer", token: "fresh-token" } } }),
    );
  });
});
