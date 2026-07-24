// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceUuid } from "../../../instances/identifiers.js";

class FakeUnauthorized extends Error {}
const createMCPClient = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient, UnauthorizedError: FakeUnauthorized }));
const servers: any[] = [];
vi.mock("../../../instances/mcp-servers.store.js", () => ({ listEnabledMcpServers: vi.fn(async () => servers) }));
vi.mock("./mcp-oauth-provider.js", () => ({ makeMcpOAuthProvider: () => ({ pendingAuthorizeUrl: "https://gh.test/authorize" }) }));

const { buildMcpTools } = await import("./mcp-tools.js");
const IID = asInstanceUuid("iid");

describe("buildMcpTools", () => {
  beforeEach(() => {
    servers.length = 0;
    createMCPClient.mockReset();
  });

  it("should_namespace_and_wrap_static_server_tools", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    const close = vi.fn();
    createMCPClient.mockResolvedValue({
      tools: async () => ({ create_issue: { description: "d", inputSchema: {}, execute: async () => "ok" } }),
      close,
    });
    const { tools, close: closeAll } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });
    expect(Object.keys(tools)).toContain("mcp__gh__create_issue");
    await closeAll();
    expect(close).toHaveBeenCalledOnce();
  });

  it("should_close_client_when_tools_enumeration_throws", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    const close = vi.fn();
    createMCPClient.mockResolvedValue({
      tools: async () => {
        throw new Error("enumeration failed");
      },
      close,
    });
    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });
    expect(Object.keys(tools)).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("should_synthesize_connect_tool_on_unauthorized", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    createMCPClient.mockRejectedValue(new FakeUnauthorized());
    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });
    expect(Object.keys(tools)).toContain("mcp__gh__connect");
    const out = await (tools["mcp__gh__connect"] as any).execute({});
    expect(out).toMatchObject({ status: "action_required", url: "https://gh.test/authorize" });
  });

  it("should_skip_oauth_server_when_no_conversationId", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: undefined });
    expect(Object.keys(tools)).toHaveLength(0);
    expect(createMCPClient).not.toHaveBeenCalled();
  });

  it("should_skip_dead_server_without_throwing", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    createMCPClient.mockRejectedValue(new Error("connection refused"));
    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });
    expect(Object.keys(tools)).toHaveLength(0);
  });
});
