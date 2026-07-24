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
};
vi.mock("../../instances/mcp-servers.store.js", () => ({
  ...store,
  MCP_AUTH_MODES: ["static", "oauth"],
}));
vi.mock("./instance-helpers.js", () => ({
  findInstanceOrFail: vi.fn(async () => ({ id: "uuid-1", slug: "acme" })),
}));
vi.mock("../../management-audit/management-audit-logger.js", () => ({
  createManagementAuditLogger: () => ({ log: vi.fn() }),
  ManagementAuditAction: { McpServerWrite: "mcp_server.write", McpServerDelete: "mcp_server.delete" },
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
  beforeEach(() => Object.values(store).forEach((f) => f.mockReset()));

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
});
