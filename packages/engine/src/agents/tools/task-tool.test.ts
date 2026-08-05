// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/ai-gateway/index.js", () => ({
  chat: vi.fn(),
}));

vi.mock("@/utils/pipeline-logger.js", () => ({
  pipelineLog: {
    toolCall: vi.fn(),
    toolResult: vi.fn(),
  },
}));

import { createTaskTool } from "./task-tool.js";
import { chat } from "../../ai-gateway/index.js";

const mockChat = vi.mocked(chat);

describe("createTaskTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a tool with description and parameters", () => {
    const tool = createTaskTool({});
    expect(tool.description).toBeDefined();
    expect(tool.inputSchema).toBeDefined();
  });

  it("calls chat with standard tier and system prompt containing the task", async () => {
    mockChat.mockResolvedValue({
      text: "Task completed successfully",
      steps: [
        {
          index: 0,
          stepType: "tool-result",
          text: "",
          toolCalls: [{ toolCallId: "tc-1", toolName: "webSearch", args: { query: "test" } }],
          toolResults: [{ toolCallId: "tc-1", result: {} }],
          finishReason: "tool-calls",
          durationMs: 100,
        },
      ],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 2000,
      model: "gpt-4o",
      provider: "openai",
    });

    const tool = createTaskTool({ someOtherTool: {} as any });
    const result = await tool.execute!(
      { task: "Research the latest AI trends", label: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "standard",
        system: expect.stringContaining("Research the latest AI trends"),
        maxSteps: 10,
      }),
      expect.objectContaining({ callType: "service" }),
    );
    expect(result).toEqual({
      success: true,
      result: "Task completed successfully",
      toolsUsed: ["webSearch"],
    });
  });

  it("returns error object on chat failure", async () => {
    mockChat.mockRejectedValue(new Error("LLM timeout"));

    const tool = createTaskTool({});
    const result = await tool.execute!(
      { task: "Do something", label: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({
      success: false,
      result: null,
      error: "LLM timeout",
    });
  });

  it("does NOT pass spawnTask to the sub-agent (prevents infinite recursion)", async () => {
    mockChat.mockResolvedValue({
      text: "ok",
      steps: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      durationMs: 1,
      model: "gpt-4o",
      provider: "openai",
    });

    const tool = createTaskTool({
      webSearch: {} as any,
      spawnTask: {} as any, // simulate the buggy case
      ask_other_agent: {} as any,
    });
    await tool.execute!(
      { task: "x", label: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    const passedTools = mockChat.mock.calls[0][0].tools as Record<string, unknown>;
    expect(passedTools).not.toHaveProperty("spawnTask");
    expect(passedTools).toHaveProperty("webSearch");
    expect(passedTools).toHaveProperty("ask_other_agent");
  });

  it("returns empty toolsUsed when no tool calls made", async () => {
    mockChat.mockResolvedValue({
      text: "Simple answer",
      steps: [],
      usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      durationMs: 500,
      model: "gpt-4o",
      provider: "openai",
    });

    const tool = createTaskTool({});
    const result = await tool.execute!(
      { task: "Answer simply", label: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect((result as { toolsUsed: string[] }).toolsUsed).toEqual([]);
  });
});
