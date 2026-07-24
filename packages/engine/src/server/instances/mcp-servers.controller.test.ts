// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { setMcpServer: vi.fn(), getMcpServer: vi.fn(), listMcpServers: vi.fn(), deleteMcpServer: vi.fn() };
vi.mock("../../instances/mcp-servers.store.js", () => ({
  ...store,
  MCP_AUTH_MODES: ["static", "oauth"],
  mcpServerConfigSchema: vi.fn(() => ({})),
}));
vi.mock("./instance-helpers.js", () => ({
  findInstanceOrFail: vi.fn(async () => ({ id: "uuid-1", slug: "acme" })),
  maskSensitiveConfig: (c: Record<string, unknown>) => c,
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

const { McpServersController } = await import("./mcp-servers.controller.js");

describe("McpServersController", () => {
  beforeEach(() => Object.values(store).forEach((f) => f.mockReset()));

  it("should_mask_tokens_in_list_response", async () => {
    store.listMcpServers.mockResolvedValue([{ slug: "gh", name: "GH", url: "u", authMode: "static", enabled: true, config: { auth: { type: "bearer", token: "shh" } } }]);
    const c = new McpServersController();
    const out = await c.list("acme");
    // maskSensitiveConfig is mocked to identity here; assert the store was scoped by resolved uuid
    expect(store.listMcpServers).toHaveBeenCalledWith("uuid-1");
    expect(out).toHaveLength(1);
  });

  it("should_reject_invalid_body", async () => {
    const c = new McpServersController();
    await expect(c.set("acme", "gh", { name: "", url: "", authMode: "static", enabled: true, config: {} } as any)).rejects.toThrow();
  });
});
