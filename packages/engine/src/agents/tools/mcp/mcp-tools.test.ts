// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceUuid } from "../../../instances/identifiers.js";

class FakeUnauthorized extends Error {}
const createMCPClient = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient, UnauthorizedError: FakeUnauthorized }));
const servers: any[] = [];
vi.mock("../../../instances/mcp-servers.store.js", () => ({ listEnabledMcpServers: vi.fn(async () => servers) }));
vi.mock("./mcp-oauth-provider.js", () => ({ makeMcpOAuthProvider: () => ({ pendingAuthorizeUrl: "https://gh.test/authorize" }) }));
// Keep the real config (registry.ts, imported transitively via this module,
// depends on it for postgres/etc.) but shrink the connect timeout so the
// timeout-path tests below stay fast (not 0 — must stay clearly slower than
// the mocked promises' microtask resolution).
vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return { ...actual, config: { ...actual.config, mcp: { connectTimeoutMs: 30 } } };
});

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

  it("should_skip_server_once_connect_timeout_elapses_and_close_a_late_resolving_client", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    const close = vi.fn().mockResolvedValue(undefined);
    let resolveTools!: (v: unknown) => void;
    createMCPClient.mockResolvedValue({
      // Never resolves within the mocked 30ms timeout — simulates a hung server.
      tools: () => new Promise((resolve) => { resolveTools = resolve; }),
      close,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });

    // Timed out -> treated exactly like a dead server: skipped, not thrown.
    expect(Object.keys(tools)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled(); // tools() is still pending, nothing to close yet

    // The server eventually replies, after buildMcpTools already gave up on it.
    resolveTools({});
    await new Promise((r) => setTimeout(r, 0));
    expect(close).toHaveBeenCalledOnce(); // the late client must not leak

    warnSpy.mockRestore();
  });

  it("should_skip_server_when_the_turn_abortSignal_fires_during_connect", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    const close = vi.fn().mockResolvedValue(undefined);
    createMCPClient.mockResolvedValue({
      tools: () => new Promise(() => { /* never resolves */ }),
      close,
    });
    const controller = new AbortController();

    const buildPromise = buildMcpTools({ instanceUuid: IID, conversationId: "c1", abortSignal: controller.signal });
    controller.abort(new Error("turn cancelled"));
    const { tools } = await buildPromise;

    expect(Object.keys(tools)).toHaveLength(0);
  });
});
