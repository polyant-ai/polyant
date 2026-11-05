// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A turn starts opening its MCP connections before the pre-model hooks finish,
 * so a cold connection is paid while they run instead of after them, and the
 * model call reads the agent's server list the turn already has.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** What happened, in order. */
const events = vi.hoisted((): string[] => []);

vi.mock("./conversations/index.js", () => ({
  conversationStore: {
    openConversationTurn: vi.fn(async () => ({ created: false, contextPrompt: null, summary: null, summaryThrough: null })),
    getHistoryWindow: vi.fn(async () => []),
  },
}));
vi.mock("./conversations/state.buffer.js", () => ({
  ConversationStateBuffer: class {
    static load = vi.fn(async () => new this());
    seedChannel() {}
    api() { return {}; }
  },
}));
vi.mock("./instances/config-resolver.js", () => ({
  resolveInstanceConfig: vi.fn(async () => ({ toolResultsInHistoryEnabled: false, langsmith: { enabled: false } })),
}));
vi.mock("./activity-stream/emit-helpers.js", () => ({ resolveInstanceMeta: vi.fn(async () => undefined) }));
vi.mock("./activity-stream/emitters/emit-inbound.js", () => ({ emitInbound: vi.fn() }));
vi.mock("./activity-stream/emitters/emit-conversation.js", () => ({ emitConversation: vi.fn() }));

// The hooks take a while: several turns of the event loop, no clock.
const turnOfTheLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
vi.mock("./hooks/hook-runner.js", () => ({
  runHooks: vi.fn(async (event: string) => {
    events.push(`${event}:start`);
    for (let i = 0; i < 5; i++) await turnOfTheLoop();
    events.push(`${event}:end`);
    return [];
  }),
  firstHalt: vi.fn(() => undefined),
  collectInjectContext: vi.fn(() => []),
  hookProvenance: vi.fn(() => undefined),
}));

const listEnabledMcpServers = vi.hoisted(() => vi.fn());
vi.mock("./instances/mcp-servers.store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instances/mcp-servers.store.js")>()),
  listEnabledMcpServers,
}));
vi.mock("./instances/instance-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instances/instance-meta.js")>()),
  resolveInstanceUuid: async () => "uuid-team",
}));
vi.mock("./platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ mcpConnectTimeoutMs: 1_000, baseUrl: "http://localhost:4000" }),
}));
vi.mock("./agents/tools/mcp/mcp-url-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents/tools/mcp/mcp-url-guard.js")>()),
  assertSafeMcpUrlResolved: async () => undefined,
}));
vi.mock("@ai-sdk/mcp", () => ({
  UnauthorizedError: class extends Error {},
  createMCPClient: vi.fn(async () => {
    events.push("mcp:connect");
    return { tools: async () => ({ lookup: { description: "d", inputSchema: {}, execute: async () => "ok" } }), close: async () => undefined };
  }),
}));

import { runPipelinePre } from "./pipeline.js";
import { buildMcpTools } from "./agents/tools/mcp/mcp-tools.js";
import { closeMcpClientPool } from "./agents/tools/mcp/mcp-client-pool.js";
import { asInstanceSlug, asInstanceUuid } from "./instances/identifiers.js";
import type { IncomingMessage } from "./channels/types.js";

const message = (): IncomingMessage => ({
  instanceId: asInstanceSlug("team"),
  channelType: "telegram",
  channelId: "42",
  userName: "u",
  text: "status?",
  metadata: {},
});

describe("runPipelinePre — MCP connections", () => {
  beforeEach(async () => {
    events.length = 0;
    await closeMcpClientPool();
    listEnabledMcpServers.mockReset();
    listEnabledMcpServers.mockResolvedValue([
      { id: "s1", slug: "crm", url: "https://mcp.test", authMode: "static", config: { auth: { type: "bearer", token: "t" } } },
    ]);
  });

  it("opens the connection while the pre-model hooks are still running", async () => {
    await runPipelinePre(message());

    expect(events).toContain("mcp:connect");
    expect(events.indexOf("mcp:connect")).toBeLessThan(events.indexOf("message_received:end"));
  });

  it("lets a turn that never reaches the model call drop a failed server read", async () => {
    listEnabledMcpServers.mockRejectedValue(new Error("database unavailable"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pre = await runPipelinePre(message());
      for (let i = 0; i < 5; i++) await turnOfTheLoop();

      expect(unhandled).not.toHaveBeenCalled();
      await expect(pre.mcpServers).rejects.toThrow("database unavailable");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("hands the model call the server list and connection the turn already started", async () => {
    const pre = await runPipelinePre(message());
    const { tools } = await buildMcpTools({
      instanceUuid: asInstanceUuid("uuid-team"),
      instanceSlug: asInstanceSlug("team"),
      conversationId: pre.ctx.conversationId,
      allowOAuth: true,
      servers: pre.mcpServers,
    });

    expect(Object.keys(tools)).toEqual(["mcp__crm__lookup"]);
    expect(listEnabledMcpServers).toHaveBeenCalledOnce();
    expect(events.filter((e) => e === "mcp:connect")).toHaveLength(1);
  });
});
