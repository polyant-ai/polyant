// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Supervisor unit tests — supervise() and superviseStream()
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../../instances/identifiers.js";

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
}));

vi.mock("../../ai-gateway/index.js", () => ({
  chat: mockChat,
  chatStream: mockChatStream,
}));

vi.mock("../tools/registry.js", () => ({
  getToolRegistry: mockGetToolRegistry,
  buildTool: mockBuildTool,
  // Pass-through: tests pass `string[]` which represents required (non-optional) keys.
  normalizeRequiredSecrets: (input: ReadonlyArray<string | { key: string }> | undefined) =>
    (input ?? []).map((e) =>
      typeof e === "string" ? { key: e, type: "text" as const } : e,
    ),
  // Pass-through: scoping is unit-tested in registry.test.ts; here it must not
  // strip secrets so the buildTools assertions see the bag they expect.
  scopeSecrets: (secrets: unknown) => secrets,
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

vi.mock("../../instances/instance-tools.store.js", () => ({
  getEnabledToolNames: mockGetEnabledToolNames,
}));

vi.mock("../../instances/store.js", () => ({
  findInstanceBySlug: mockFindInstanceBySlug,
}));

// Mocks for the new agent-to-agent imports. The supervisor reaches into
// channelManager.getAdapter() to synthesise `ask_{slug}` tools — return
// undefined here so the loop short-circuits and no agent tools are added
// during supervisor tests.
vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: {
    getAdapter: vi.fn().mockReturnValue(undefined),
  },
}));

vi.mock("../tools/agent-invoke.helpers.js", () => ({
  buildAgentInvokeTool: vi.fn(),
}));

vi.mock("../../channels/adapters/agent.adapter.js", () => ({}));

import { supervise, superviseStream } from "./index.js";
import type { SupervisorInput } from "./index.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const defaultChatResponse = {
  text: "Hello from supervisor",
  steps: [],
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  durationMs: 1234,
  model: "gpt-4o",
  provider: "openai",
};

beforeEach(() => {
  vi.clearAllMocks();

  mockFindInstanceBySlug.mockResolvedValue({ id: "uuid-123", slug: "my-instance" });
  mockGetEnabledToolNames.mockResolvedValue(new Set(["read", "write"]));
  mockGetToolRegistry.mockReturnValue(
    new Map([
      ["read", { name: "read", description: "Read files", category: "workspace", create: vi.fn() }],
      ["write", { name: "write", description: "Write files", category: "workspace", create: vi.fn() }],
      ["saveMemory", { name: "saveMemory", description: "Save memory", category: "memory", create: vi.fn() }],
    ]),
  );
  mockBuildTool.mockReturnValue({ _type: "mock-tool" });
  mockCreateTaskTool.mockReturnValue({ _type: "task-tool" });
  mockBuildPrompt.mockResolvedValue("System prompt content");
  mockChat.mockResolvedValue(defaultChatResponse);
});

// =========================================================================
// supervise()
// =========================================================================

describe("supervise", () => {
  it("resolves instance by slug", async () => {
    await supervise({ message: "hi", instanceId: asInstanceSlug("my-instance") });

    expect(mockFindInstanceBySlug).toHaveBeenCalledWith("my-instance");
  });

  it("falls back to DEFAULT_INSTANCE_ID when instanceId is not provided", async () => {
    await supervise({ message: "hi" });

    expect(mockFindInstanceBySlug).toHaveBeenCalledWith("default");
  });

  it("calls chat with tier standard, system prompt, messages, and tools", async () => {
    await supervise({ message: "hi", instanceId: asInstanceSlug("inst-1") });

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "standard",
        system: "System prompt content",
        maxSteps: 15,
      }),
      expect.objectContaining({
        instanceId: "inst-1",
      }),
    );

    // The messages array should contain the user message
    const callArgs = mockChat.mock.calls[0][0];
    const lastMsg = callArgs.messages[callArgs.messages.length - 1];
    expect(lastMsg).toEqual({ role: "user", content: "hi" });
  });

  it("returns SupervisorOutput with text, usage, durationMs", async () => {
    const result = await supervise({ message: "hi" });

    expect(result).toEqual(expect.objectContaining({
      text: "Hello from supervisor",
      // Empty multi-step trace: no tools were used in this run.
      steps: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 1234,
    }));
  });

  it("returns toolBuildingMs in output", async () => {
    const result = await supervise({ message: "hi" });

    expect(result.toolBuildingMs).toEqual(expect.any(Number));
    expect(result.toolBuildingMs).toBeGreaterThanOrEqual(0);
    // toolCallTraces is undefined when no tools were actually executed
    expect(result.toolCallTraces).toBeUndefined();
  });

  it("passes provider, model, apiKeys, langsmith from input to chat", async () => {
    const input: SupervisorInput = {
      message: "hi",
      provider: "anthropic",
      model: "claude-3-opus",
      apiKeys: { anthropic: "sk-ant-xxx" },
      langsmith: { apiKey: "ls-key", project: "my-project" },
    };

    await supervise(input);

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-3-opus",
        apiKeys: { anthropic: "sk-ant-xxx" },
        langsmith: { apiKey: "ls-key", project: "my-project" },
      }),
      expect.anything(),
    );
  });

  it("forwards temperature to the gateway when provided", async () => {
    await supervise({ message: "hi", temperature: 0.2 });
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.2 }),
      expect.anything(),
    );
  });

  it("omits temperature when not provided", async () => {
    await supervise({ message: "hi" });
    expect(mockChat).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.anything() }),
      expect.anything(),
    );
  });

  it("passes conversationId in metadata", async () => {
    await supervise({ message: "hi", conversationId: "conv-42" });

    expect(mockChat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: "conv-42" }),
    );
  });

  it("calls pipelineLog.supervisorStart and supervisorDone", async () => {
    await supervise({ message: "hi" });

    expect(mockPipelineLog.supervisorStart).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    expect(mockPipelineLog.supervisorDone).toHaveBeenCalledWith(expect.any(String), 1234, "Hello from supervisor");
  });

  // -----------------------------------------------------------------------
  // buildMessages (tested indirectly)
  // -----------------------------------------------------------------------

  describe("message construction", () => {
    it("without summary: only history + current message", async () => {
      const history = [
        { role: "user" as const, content: "first" },
        { role: "assistant" as const, content: "reply" },
      ];
      await supervise({ message: "second", conversationHistory: history });

      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]);
    });

    it("with summary and history: passes summary to system prompt, not messages", async () => {
      const history = [
        { role: "user" as const, content: "latest msg" },
        { role: "assistant" as const, content: "latest reply" },
      ];
      await supervise({
        message: "new question",
        conversationHistory: history,
        conversationSummary: "The user asked about weather",
      });

      // Summary goes to buildSupervisorSystemPrompt, not into messages
      expect(mockBuildPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ conversationSummary: "The user asked about weather" }),
      );

      // Messages contain only history + current message (no fake summary pair)
      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "latest msg" },
        { role: "assistant", content: "latest reply" },
        { role: "user", content: "new question" },
      ]);
    });

    it("with summary but no history: does not inject summary pair", async () => {
      await supervise({
        message: "hello",
        conversationSummary: "old summary",
        conversationHistory: [],
      });

      const callArgs = mockChat.mock.calls[0][0];
      // conversationHistory is [] which is falsy for .length, so summary is NOT injected
      expect(callArgs.messages).toEqual([
        { role: "user", content: "hello" },
      ]);
    });

    it("without history: just the current message", async () => {
      await supervise({ message: "standalone" });

      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "standalone" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // buildTools (tested indirectly)
  // -----------------------------------------------------------------------

  describe("tool building", () => {
    it("excludes memory tools when memoryEnabled is false", async () => {
      // DB returns saveMemory as enabled
      mockGetEnabledToolNames.mockResolvedValue(new Set(["read", "write", "saveMemory"]));

      await supervise({ message: "hi", memoryEnabled: false });

      // buildTool should be called for read and write, but not saveMemory
      const builtToolNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtToolNames).toContain("read");
      expect(builtToolNames).toContain("write");
      expect(builtToolNames).not.toContain("saveMemory");
    });

    it("includes memory tools when memoryEnabled is true", async () => {
      mockGetEnabledToolNames.mockResolvedValue(new Set(["read", "saveMemory"]));

      await supervise({ message: "hi", memoryEnabled: true });

      const builtToolNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtToolNames).toContain("saveMemory");
    });

    it("skips tools with missing requiredSecrets", async () => {
      mockGetToolRegistry.mockReturnValue(
        new Map([
          ["read", { name: "read", description: "Read", category: "workspace", create: vi.fn() }],
          ["tavily", { name: "tavily", description: "Tavily search", category: "search", requiredSecrets: ["tavily_api_key"], create: vi.fn() }],
        ]),
      );
      mockGetEnabledToolNames.mockResolvedValue(new Set(["read", "tavily"]));

      // No secrets provided
      await supervise({ message: "hi", secrets: {} });

      const builtToolNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtToolNames).toContain("read");
      expect(builtToolNames).not.toContain("tavily");
    });

    it("includes tools when requiredSecrets are present", async () => {
      mockGetToolRegistry.mockReturnValue(
        new Map([
          ["tavily", { name: "tavily", description: "Tavily", category: "search", requiredSecrets: ["tavily_api_key"], create: vi.fn() }],
        ]),
      );
      mockGetEnabledToolNames.mockResolvedValue(new Set(["tavily"]));

      await supervise({ message: "hi", secrets: { tavily_api_key: "key123" } });

      const builtToolNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtToolNames).toContain("tavily");
    });

    it("includes spawnTask when in enabled tool names", async () => {
      mockGetEnabledToolNames.mockResolvedValue(new Set(["read", "spawnTask"]));

      await supervise({ message: "hi" });

      expect(mockCreateTaskTool).toHaveBeenCalled();
      // The tools passed to chat should include spawnTask
      const toolsArg = mockChat.mock.calls[0][0].tools;
      expect(toolsArg).toHaveProperty("spawnTask");
    });

    it("presents a namespaced plugin tool to the model with ':' sanitized to '__'", async () => {
      mockGetToolRegistry.mockReturnValue(
        new Map([
          ["innova:aggiornaBollettaCrm", { name: "innova:aggiornaBollettaCrm", description: "d", category: "plugin", inputSchema: { type: "object" }, execute: vi.fn() }],
        ]),
      );
      mockGetEnabledToolNames.mockResolvedValue(new Set(["innova:aggiornaBollettaCrm"]));

      await supervise({ message: "hi" });

      // Bedrock/OpenAI/Anthropic reject ':' in a tool name; the model must see '__'.
      const toolsArg = mockChat.mock.calls[0][0].tools;
      expect(toolsArg).toHaveProperty("innova__aggiornaBollettaCrm");
      expect(toolsArg).not.toHaveProperty("innova:aggiornaBollettaCrm");
      // The canonical ':' name stays the identity for governance/audit (buildTool
      // is called with the original def whose name keeps the ':').
      const builtNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtNames).toContain("innova:aggiornaBollettaCrm");
    });

    it("does not include spawnTask when not in enabled tool names", async () => {
      mockGetEnabledToolNames.mockResolvedValue(new Set(["read"]));

      await supervise({ message: "hi" });

      expect(mockCreateTaskTool).not.toHaveBeenCalled();
    });

    it("empty enabled names (size=0) enables all tools including spawnTask", async () => {
      mockGetEnabledToolNames.mockResolvedValue(new Set()); // empty = all enabled

      await supervise({ message: "hi" });

      // All tools from registry should be built
      expect(mockBuildTool).toHaveBeenCalledTimes(3); // read, write, saveMemory
      // spawnTask is also added
      expect(mockCreateTaskTool).toHaveBeenCalled();
    });

    it("excludes harness tools when includeHarness is not provided", async () => {
      mockGetToolRegistry.mockReturnValue(
        new Map([
          ["read", { name: "read", description: "Read files", category: "workspace", create: vi.fn() }],
          ["roomNotify", { name: "roomNotify", description: "Send room notification", category: "room", harness: true, create: vi.fn() }],
        ]),
      );
      mockGetEnabledToolNames.mockResolvedValue(new Set(["read", "roomNotify"]));

      await supervise({ message: "hi" });

      const builtToolNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtToolNames).toContain("read");
      expect(builtToolNames).not.toContain("roomNotify");
    });

    it("includes harness tools when includeHarness matches category", async () => {
      mockGetToolRegistry.mockReturnValue(
        new Map([
          ["read", { name: "read", description: "Read files", category: "workspace", create: vi.fn() }],
          ["roomNotify", { name: "roomNotify", description: "Send room notification", category: "room", harness: true, create: vi.fn() }],
        ]),
      );
      mockGetEnabledToolNames.mockResolvedValue(new Set(["read", "roomNotify"]));

      await supervise({ message: "hi", includeHarness: new Set(["room"]) });

      const builtToolNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtToolNames).toContain("read");
      expect(builtToolNames).toContain("roomNotify");
    });

    it("excludes harness tools when includeHarness does not match category", async () => {
      mockGetToolRegistry.mockReturnValue(
        new Map([
          ["roomNotify", { name: "roomNotify", description: "Send room notification", category: "room", harness: true, create: vi.fn() }],
        ]),
      );
      mockGetEnabledToolNames.mockResolvedValue(new Set(["roomNotify"]));

      await supervise({ message: "hi", includeHarness: new Set(["other"]) });

      const builtToolNames = mockBuildTool.mock.calls.map((c: unknown[]) => (c[0] as { name: string }).name);
      expect(builtToolNames).not.toContain("roomNotify");
    });

    it("passes apiKeys, instanceId, and conversationId to createTaskTool", async () => {
      mockGetEnabledToolNames.mockResolvedValue(new Set(["spawnTask"]));

      const apiKeys = { openai: "sk-test" };
      await supervise({ message: "hi", apiKeys, instanceId: asInstanceSlug("my-instance"), conversationId: "conv-1" });

      expect(mockCreateTaskTool).toHaveBeenCalledWith(
        expect.any(Object),
        apiKeys,
        "my-instance",
        "conv-1",
      );
    });
  });
});

// =========================================================================
// superviseStream()
// =========================================================================

describe("superviseStream", () => {
  let mockTextStream: AsyncIterable<string>;
  let mockFullStream: AsyncIterable<unknown>;
  let mockResponse: Promise<typeof defaultChatResponse>;

  beforeEach(() => {
    mockTextStream = (async function* () {
      yield "Hello ";
      yield "world";
    })();
    mockFullStream = (async function* () {
      yield { type: "text-delta", textDelta: "Hello " };
    })();
    mockResponse = Promise.resolve(defaultChatResponse);

    mockChatStream.mockReturnValue({
      textStream: mockTextStream,
      fullStream: mockFullStream,
      response: mockResponse,
    });
  });

  it("resolves instance by slug", async () => {
    await superviseStream({ message: "hi", instanceId: asInstanceSlug("stream-inst") });

    expect(mockFindInstanceBySlug).toHaveBeenCalledWith("stream-inst");
  });

  it("falls back to DEFAULT_INSTANCE_ID when instanceId is not provided", async () => {
    await superviseStream({ message: "hi" });

    expect(mockFindInstanceBySlug).toHaveBeenCalledWith("default");
  });

  it("returns textStream, fullStream, and completed promise", async () => {
    const result = await superviseStream({ message: "hi" });

    expect(result.textStream).toBeDefined();
    expect(result.fullStream).toBeDefined();
    expect(result.completed).toBeInstanceOf(Promise);
  });

  it("completed resolves with SupervisorOutput", async () => {
    const result = await superviseStream({ message: "hi" });
    const output = await result.completed;

    expect(output).toEqual(expect.objectContaining({
      text: "Hello from supervisor",
      // Empty multi-step trace: no tools were used in this run.
      steps: [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 1234,
    }));
  });

  it("completed includes toolBuildingMs and ttfbMs after consuming stream", async () => {
    // Make response resolve only after stream is consumed (like real SDK behavior)
    let resolveResponse: (v: typeof defaultChatResponse) => void;
    const deferredResponse = new Promise<typeof defaultChatResponse>((r) => {
      resolveResponse = r;
    });

    const chunks = ["Hello ", "world"];
    const deferredTextStream = (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();

    mockChatStream.mockReturnValue({
      textStream: deferredTextStream,
      fullStream: mockFullStream,
      response: deferredResponse,
    });

    const result = await superviseStream({ message: "hi" });

    // Consume textStream to trigger TTFB capture
    for await (const _chunk of result.textStream) { void _chunk; }

    // Now resolve the response (simulating real SDK behavior)
    resolveResponse!(defaultChatResponse);
    const output = await result.completed;

    expect(output.toolBuildingMs).toEqual(expect.any(Number));
    expect(output.toolBuildingMs).toBeGreaterThanOrEqual(0);
    // toolCallTraces is undefined when no tools were actually executed
    expect(output.toolCallTraces).toBeUndefined();
    expect(output.ttfbMs).toEqual(expect.any(Number));
  });

  it("calls chatStream with standard tier and system prompt", async () => {
    await superviseStream({ message: "test", instanceId: asInstanceSlug("x") });

    expect(mockChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "standard",
        system: "System prompt content",
        maxSteps: 15,
      }),
      expect.objectContaining({ instanceId: "x" }),
    );
  });

  it("passes provider, model, apiKeys, langsmith to chatStream", async () => {
    await superviseStream({
      message: "hi",
      provider: "openai",
      model: "gpt-4o",
      apiKeys: { openai: "sk-xxx" },
      langsmith: { apiKey: "ls", project: "proj" },
    });

    expect(mockChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4o",
        apiKeys: { openai: "sk-xxx" },
        langsmith: { apiKey: "ls", project: "proj" },
      }),
      expect.anything(),
    );
  });

  it("calls pipelineLog on stream completion", async () => {
    const result = await superviseStream({ message: "hi" });
    await result.completed;

    expect(mockPipelineLog.supervisorDone).toHaveBeenCalledWith(expect.any(String), 1234, "Hello from supervisor");
  });

  it("passes conversationSummary to system prompt, not messages", async () => {
    const history = [{ role: "user" as const, content: "prev" }];

    await superviseStream({
      message: "next",
      conversationHistory: history,
      conversationSummary: "summary of current conversation",
    });

    // Summary goes to buildSupervisorSystemPrompt
    expect(mockBuildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ conversationSummary: "summary of current conversation" }),
    );

    // Messages contain only history + current message
    const callArgs = mockChatStream.mock.calls[0][0];
    expect(callArgs.messages).toEqual([
      { role: "user", content: "prev" },
      { role: "user", content: "next" },
    ]);
  });
});
