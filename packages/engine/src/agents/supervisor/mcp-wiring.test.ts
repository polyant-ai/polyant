// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Supervisor <-> MCP wiring — merge into ctx.tools + per-turn teardown
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockChat,
  mockChatStream,
  mockGetEnabledToolNames,
  mockFindInstanceBySlug,
  mockGetToolRegistry,
  mockBuildTool,
  mockCreateTaskTool,
  mockBuildPrompt,
  mockPipelineLog,
  mockBuildMcpTools,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockChatStream: vi.fn(),
  mockGetEnabledToolNames: vi.fn(),
  mockFindInstanceBySlug: vi.fn(),
  mockGetToolRegistry: vi.fn(),
  mockBuildTool: vi.fn(),
  mockCreateTaskTool: vi.fn(),
  mockBuildPrompt: vi.fn(),
  mockPipelineLog: {
    systemPrompt: vi.fn(),
    supervisorStart: vi.fn(),
    supervisorDone: vi.fn(),
  },
  mockBuildMcpTools: vi.fn(),
}));

vi.mock("../../ai-gateway/index.js", () => ({
  chat: mockChat,
  chatStream: mockChatStream,
}));

vi.mock("../tools/registry.js", () => ({
  getToolRegistry: mockGetToolRegistry,
  buildTool: mockBuildTool,
  normalizeRequiredSecrets: (input: ReadonlyArray<string | { key: string }> | undefined) =>
    (input ?? []).map((e) => (typeof e === "string" ? { key: e, type: "text" as const } : e)),
  scopeSecrets: (secrets: unknown) => secrets,
  toModelToolName: (name: string) => name.replace(/:/g, "__"),
}));

vi.mock("../tools/task-tool.js", () => ({
  createTaskTool: mockCreateTaskTool,
}));

vi.mock("./prompt.js", () => ({
  buildSupervisorSystemPrompt: mockBuildPrompt,
}));

vi.mock("../../utils/pipeline-logger.js", () => ({
  pipelineLog: mockPipelineLog,
}));

vi.mock("../../config.js", () => ({
  DEFAULT_INSTANCE_ID: "default",
  config: { agent: { callTimeoutMs: 60000 }, plugins: {} },
}));

vi.mock("../../database/client.js", () => ({ db: {}, queryClient: {} }));

vi.mock("../../instances/instance-tools.store.js", () => ({
  getEnabledToolNames: mockGetEnabledToolNames,
}));

vi.mock("../../instances/store.js", () => ({
  findInstanceBySlug: mockFindInstanceBySlug,
}));

vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: {
    getAdapter: vi.fn().mockReturnValue(undefined),
  },
}));

vi.mock("../tools/agent-invoke.helpers.js", () => ({
  buildAgentInvokeTool: vi.fn(),
}));

vi.mock("../../channels/adapters/agent.adapter.js", () => ({}));

vi.mock("../tools/mcp/mcp-tools.js", () => ({
  buildMcpTools: mockBuildMcpTools,
}));

import { supervise, superviseStream } from "./index.js";

const defaultChatResponse = {
  text: "Hello from supervisor",
  steps: [],
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  durationMs: 1234,
  model: "gpt-4o",
  provider: "openai",
};

const mcpTool = { _type: "mock-mcp-tool" };

beforeEach(() => {
  vi.clearAllMocks();

  mockFindInstanceBySlug.mockResolvedValue({ id: "uuid-123", slug: "my-instance" });
  // Non-empty set with no matching registry entries: keeps buildTools() output
  // empty (no spawnTask, no core tools) so assertions focus on the MCP merge.
  mockGetEnabledToolNames.mockResolvedValue(new Set(["nonexistent"]));
  mockGetToolRegistry.mockReturnValue(new Map());
  mockBuildTool.mockReturnValue({ _type: "mock-tool" });
  mockCreateTaskTool.mockReturnValue({ _type: "task-tool" });
  mockBuildPrompt.mockResolvedValue({ system: "System prompt content", turnContext: "" });
  mockChat.mockResolvedValue(defaultChatResponse);
  mockBuildMcpTools.mockResolvedValue({
    tools: { mcp__gh__x: mcpTool },
    close: vi.fn().mockResolvedValue(undefined),
  });
});

describe("supervise + MCP tools", () => {
  it("merges MCP tools into the tools passed to chat", async () => {
    await supervise({ message: "hi" });

    const toolsArg = mockChat.mock.calls[0][0].tools;
    expect(toolsArg).toHaveProperty("mcp__gh__x", mcpTool);
  });

  it("passes instanceUuid + conversationId to buildMcpTools", async () => {
    await supervise({ message: "hi", conversationId: "conv-1" });

    expect(mockBuildMcpTools).toHaveBeenCalledWith({ instanceUuid: "uuid-123", conversationId: "conv-1" });
  });

  it("calls close() exactly once after a successful turn", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpTools.mockResolvedValue({ tools: { mcp__gh__x: mcpTool }, close });

    await supervise({ message: "hi" });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls close() even when chat() throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpTools.mockResolvedValue({ tools: { mcp__gh__x: mcpTool }, close });
    mockChat.mockRejectedValue(new Error("boom"));

    await expect(supervise({ message: "hi" })).rejects.toThrow("boom");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls close() when buildSupervisorSystemPrompt throws (leak window after buildMcpTools opens clients)", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpTools.mockResolvedValue({ tools: { mcp__gh__x: mcpTool }, close });
    mockBuildPrompt.mockRejectedValue(new Error("prompt boom"));

    await expect(supervise({ message: "hi" })).rejects.toThrow("prompt boom");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not let an MCP tool clobber a same-named core tool", async () => {
    mockGetToolRegistry.mockReturnValue(
      new Map([["search", { name: "search", description: "Core search", category: "workspace", create: vi.fn() }]]),
    );
    mockGetEnabledToolNames.mockResolvedValue(new Set(["search"]));
    mockBuildMcpTools.mockResolvedValue({ tools: { search: mcpTool }, close: vi.fn().mockResolvedValue(undefined) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await supervise({ message: "hi" });

    const toolsArg = mockChat.mock.calls[0][0].tools;
    expect(toolsArg.search).not.toBe(mcpTool);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("search"));
    warnSpy.mockRestore();
  });

  it("audit-wraps a merged MCP tool: invoking it records a toolCallTraces entry", async () => {
    const mcpToolWithExecute = {
      description: "MCP tool",
      inputSchema: { type: "object" },
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };
    mockBuildMcpTools.mockResolvedValue({
      tools: { mcp__gh__x: mcpToolWithExecute },
      close: vi.fn().mockResolvedValue(undefined),
    });
    // Simulate the AI SDK invoking the merged tool mid-turn, exactly like it
    // would for any other equipped tool.
    mockChat.mockImplementation(async (opts) => {
      await opts.tools.mcp__gh__x.execute({});
      return defaultChatResponse;
    });

    const result = await supervise({ message: "hi" });

    expect(mcpToolWithExecute.execute).toHaveBeenCalledOnce();
    expect(result.toolCallTraces).toEqual([
      expect.objectContaining({ name: "mcp__gh__x", success: true }),
    ]);
  });
});

describe("superviseStream + MCP tools", () => {
  beforeEach(() => {
    mockChatStream.mockReturnValue({
      textStream: (async function* () {
        yield "hi";
      })(),
      fullStream: (async function* () {
        yield { type: "text-delta" };
      })(),
      response: Promise.resolve(defaultChatResponse),
    });
  });

  it("merges MCP tools into the tools passed to chatStream", async () => {
    await superviseStream({ message: "hi" });

    const toolsArg = mockChatStream.mock.calls[0][0].tools;
    expect(toolsArg).toHaveProperty("mcp__gh__x", mcpTool);
  });

  it("does not close MCP clients before the stream completes", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpTools.mockResolvedValue({ tools: { mcp__gh__x: mcpTool }, close });

    await superviseStream({ message: "hi" });

    expect(close).not.toHaveBeenCalled();
  });

  it("closes MCP clients once the completed promise settles", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpTools.mockResolvedValue({ tools: { mcp__gh__x: mcpTool }, close });

    const result = await superviseStream({ message: "hi" });
    await result.completed;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes MCP clients even when the underlying stream response rejects", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpTools.mockResolvedValue({ tools: { mcp__gh__x: mcpTool }, close });
    mockChatStream.mockReturnValue({
      textStream: (async function* () {})(),
      fullStream: (async function* () {})(),
      response: Promise.reject(new Error("stream boom")),
    });

    const result = await superviseStream({ message: "hi" });
    await expect(result.completed).rejects.toThrow("stream boom");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls close() when chatStream() throws synchronously (before a stream/completed exists)", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mockBuildMcpTools.mockResolvedValue({ tools: { mcp__gh__x: mcpTool }, close });
    mockChatStream.mockImplementation(() => {
      throw new Error("chatStream boom");
    });

    await expect(superviseStream({ message: "hi" })).rejects.toThrow("chatStream boom");

    expect(close).toHaveBeenCalledTimes(1);
  });
});
