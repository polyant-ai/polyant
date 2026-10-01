// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceUuid, asInstanceSlug } from "../../../instances/identifiers.js";
// Skips are announced through the module's own logger, not `console.warn`: the
// lines interpolate remote-controlled text, so they go through createLogger's
// sanitizing formatter (see mcp-logger.ts). Spy there.
import { mcpLog } from "./mcp-logger.js";

class FakeUnauthorized extends Error {}
const createMCPClient = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient, UnauthorizedError: FakeUnauthorized }));
const servers: any[] = [];
vi.mock("../../../instances/mcp-servers.store.js", () => ({ listEnabledMcpServers: vi.fn(async () => servers) }));
vi.mock("./mcp-oauth-provider.js", () => ({ makeMcpOAuthProvider: () => ({ pendingAuthorizeUrl: "https://gh.test/authorize" }) }));
// Keep the real config: registry.ts, imported transitively via this module,
// depends on it for postgres/etc.
vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return { ...actual, config: { ...actual.config } };
});

// The connect budget is a platform policy now, and this suite has no database.
// Shrunk so the timeout-path tests below stay fast — not 0, which must stay
// clearly slower than the mocked promises' microtask resolution.
vi.mock("../../../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ mcpConnectTimeoutMs: 30, baseUrl: "http://localhost:4000" }),
}));

const { buildMcpTools } = await import("./mcp-tools.js");
const { closeMcpClientPool, mcpPoolSize } = await import("./mcp-client-pool.js");
const IID = asInstanceUuid("iid");
const SLUG = asInstanceSlug("my-instance");

describe("buildMcpTools", () => {
  beforeEach(async () => {
    servers.length = 0;
    // The pool outlives a turn by design; each test starts without one.
    await closeMcpClientPool();
    createMCPClient.mockReset();
  });

  it("should_namespace_and_wrap_static_server_tools_and_keep_the_pooled_client_past_the_turn", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    const close = vi.fn();
    createMCPClient.mockResolvedValue({
      tools: async () => ({ create_issue: { description: "d", inputSchema: {}, execute: async () => "ok" } }),
      close,
    });
    const { tools, close: closeAll } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });
    expect(Object.keys(tools)).toContain("mcp__gh__create_issue");
    await closeAll();
    // Pooled: the end of the turn does not close it; shutdown does.
    expect(close).not.toHaveBeenCalled();
    await closeMcpClientPool();
    expect(close).toHaveBeenCalledOnce();
  });

  describe("connection pool", () => {
    const staticServer = (id: string, token = "t") => ({ id, slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token } } });
    const okClient = (execute: () => Promise<unknown> = async () => "ok") => ({
      tools: async () => ({ create_issue: { description: "d", inputSchema: {}, execute } }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    it("should_reuse_one_connection_across_turns", async () => {
      servers.push(staticServer("s1"));
      createMCPClient.mockResolvedValue(okClient());

      await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });
      await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c2" });
      await Promise.all([1, 2, 3].map((n) => buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: `c${n + 2}` })));

      expect(createMCPClient).toHaveBeenCalledOnce();
      expect(mcpPoolSize()).toBe(1);
    });

    it("should_reconnect_when_the_server_record_changes", async () => {
      servers.push(staticServer("s1", "old-token"));
      createMCPClient.mockResolvedValue(okClient());
      await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });

      servers[0] = staticServer("s1", "new-token");
      await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c2" });

      expect(createMCPClient).toHaveBeenCalledTimes(2);
    });

    it("should_reconnect_on_the_next_turn_after_a_call_fails", async () => {
      servers.push(staticServer("s1"));
      createMCPClient.mockResolvedValue(okClient(async () => { throw new Error("session expired"); }));
      const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });

      await expect((tools["mcp__gh__create_issue"] as any).execute({}, {})).rejects.toThrow("session expired");
      await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c2" });

      expect(createMCPClient).toHaveBeenCalledTimes(2);
    });

    it("should_reconnect_once_the_connection_is_a_minute_old", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        servers.push(staticServer("s1"));
        createMCPClient.mockResolvedValue(okClient());
        await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });

        vi.setSystemTime(Date.now() + 59_000);
        await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c2" });
        expect(createMCPClient).toHaveBeenCalledOnce();

        vi.setSystemTime(Date.now() + 2_000);
        await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c3" });
        expect(createMCPClient).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should_not_pool_an_oauth_server_and_close_it_at_the_end_of_the_turn", async () => {
      servers.push({ id: "s-oauth", slug: "gh", url: "https://x", authMode: "oauth", config: {} });
      const client = okClient();
      createMCPClient.mockResolvedValue(client);

      const { close } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1", allowOAuth: true });
      await close();

      expect(client.close).toHaveBeenCalledOnce();
      expect(mcpPoolSize()).toBe(0);
    });
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
    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });
    expect(Object.keys(tools)).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("should_synthesize_connect_tool_on_unauthorized", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    createMCPClient.mockRejectedValue(new FakeUnauthorized());
    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1", allowOAuth: true });
    expect(Object.keys(tools)).toContain("mcp__gh__connect");
    const out = await (tools["mcp__gh__connect"] as any).execute({});
    expect(out).toMatchObject({ status: "action_required", url: "https://gh.test/authorize" });
  });

  it("should_skip_oauth_server_when_no_conversationId", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    // allowOAuth granted, but no stable conversation to persist tokens against —
    // the defensive fallback guard must hold on its own, independent of allowOAuth.
    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: undefined, allowOAuth: true });
    expect(Object.keys(tools)).toHaveLength(0);
    expect(createMCPClient).not.toHaveBeenCalled();
  });

  it("should_skip_dead_server_without_throwing", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    createMCPClient.mockRejectedValue(new Error("connection refused"));
    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });
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
    const warnSpy = vi.spyOn(mcpLog, "warn").mockImplementation(() => undefined);

    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });

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

    const buildPromise = buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1", abortSignal: controller.signal });
    controller.abort(new Error("turn cancelled"));
    const { tools } = await buildPromise;

    expect(Object.keys(tools)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Defect A: remote tool names are attacker/operator-controlled and only get
  // ':' -> '__' from toModelToolName — a name with '.', '/', spaces, or
  // non-ASCII chars must be SANITIZED (kept, renamed), never dropped, or the
  // provider 400s the whole turn.
  // ---------------------------------------------------------------------------

  it("should_sanitize_remote_tool_names_outside_the_provider_charset", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    createMCPClient.mockResolvedValue({
      tools: async () => ({
        "create.issue": { description: "d", inputSchema: {}, execute: async () => "created" },
        "search files": { description: "d", inputSchema: {}, execute: async () => "found" },
        "wéird!": { description: "d", inputSchema: {}, execute: async () => "weird" },
      }),
      close: vi.fn(),
    });

    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });

    const keys = Object.keys(tools);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it("should_still_invoke_the_remote_tool_through_its_sanitized_key", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    const execute = vi.fn().mockResolvedValue("created");
    createMCPClient.mockResolvedValue({
      tools: async () => ({ "create.issue": { description: "d", inputSchema: {}, execute } }),
      close: vi.fn(),
    });

    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });

    expect(Object.keys(tools)).toContain("mcp__gh__create_issue");
    await (tools["mcp__gh__create_issue"] as any).execute({});
    expect(execute).toHaveBeenCalledOnce();
  });

  it("should_skip_a_second_remote_tool_that_sanitizes_to_the_same_key", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    const firstExecute = vi.fn().mockResolvedValue("first");
    const secondExecute = vi.fn().mockResolvedValue("second");
    createMCPClient.mockResolvedValue({
      // "create.issue" and "create/issue" both sanitize to "create_issue".
      tools: async () => ({
        "create.issue": { description: "first", inputSchema: {}, execute: firstExecute },
        "create/issue": { description: "second", inputSchema: {}, execute: secondExecute },
      }),
      close: vi.fn(),
    });
    const warnSpy = vi.spyOn(mcpLog, "warn").mockImplementation(() => undefined);

    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "c1" });

    expect(Object.keys(tools).filter((k) => k.endsWith("create_issue"))).toHaveLength(1);
    await (tools["mcp__gh__create_issue"] as any).execute({});
    expect(firstExecute).toHaveBeenCalledOnce();
    expect(secondExecute).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("mcp", expect.stringContaining("create/issue"));

    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Defect B: an oauth server must not be attempted just because a (possibly
  // ephemeral) conversationId happens to be truthy — the caller must explicitly
  // grant allowOAuth.
  // ---------------------------------------------------------------------------

  it("should_skip_oauth_server_for_a_room_conversation_when_allowOAuth_is_not_set", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    const warnSpy = vi.spyOn(mcpLog, "warn").mockImplementation(() => undefined);

    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "room:inst:123" });

    expect(Object.keys(tools)).toHaveLength(0);
    expect(createMCPClient).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("mcp", expect.stringContaining("gh"));

    warnSpy.mockRestore();
  });

  it("should_skip_oauth_server_for_a_webhook_match_when_allowOAuth_is_not_set", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });

    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "event-match:def-1" });

    expect(Object.keys(tools)).toHaveLength(0);
    expect(createMCPClient).not.toHaveBeenCalled();
  });

  it("should_still_attempt_oauth_server_for_a_normal_conversational_id_when_allowOAuth_is_true", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    createMCPClient.mockRejectedValue(new FakeUnauthorized());

    const { tools } = await buildMcpTools({ instanceUuid: IID, instanceSlug: SLUG, conversationId: "inst:web:user1", allowOAuth: true });

    // The attempt happened (createMCPClient was invoked) and synthesized the connect tool.
    expect(createMCPClient).toHaveBeenCalledOnce();
    expect(Object.keys(tools)).toContain("mcp__gh__connect");
  });
});
