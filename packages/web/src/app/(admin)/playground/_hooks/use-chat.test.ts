// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  chatReducer,
  createInitialState,
  type ChatState,
  type ChatAction,
} from "./use-chat";

const SLUG = "test-instance";

function withAssistantMessage(state: ChatState): ChatState {
  return chatReducer(state, { type: "SEND_MESSAGE", text: "hi" } as ChatAction);
}

describe("chatReducer", () => {
  it("SEND_MESSAGE creates user + streaming assistant messages", () => {
    const state = chatReducer(createInitialState(SLUG), {
      type: "SEND_MESSAGE",
      text: "hello",
    });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
      isStreaming: false,
    });
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      isStreaming: true,
      reasoning: [],
      steps: [],
    });
    expect(state.isStreaming).toBe(true);
  });

  describe("TEXT_DELTA", () => {
    it("appends to the streaming assistant content", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "TEXT_DELTA", text: "Hel" });
      s = chatReducer(s, { type: "TEXT_DELTA", text: "lo" });
      expect(s.messages[1].content).toBe("Hello");
    });

    it("ignores delta when no streaming assistant exists", () => {
      const s = chatReducer(createInitialState(SLUG), { type: "TEXT_DELTA", text: "x" });
      expect(s.messages).toHaveLength(0);
    });
  });

  describe("REASONING_DELTA + REASONING_SIGNATURE", () => {
    it("accumulates into a single open text block", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "REASONING_DELTA", text: "th" });
      s = chatReducer(s, { type: "REASONING_DELTA", text: "ink" });
      expect(s.messages[1].reasoning).toEqual([{ type: "text", text: "think" }]);
    });

    it("attaches signature to the most recent text block and seals it", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "REASONING_DELTA", text: "thought-1" });
      s = chatReducer(s, { type: "REASONING_SIGNATURE", signature: "sig-1" });
      // Subsequent delta should NOT mutate the signed block; it opens a new one
      s = chatReducer(s, { type: "REASONING_DELTA", text: "thought-2" });
      expect(s.messages[1].reasoning).toEqual([
        { type: "text", text: "thought-1", signature: "sig-1" },
        { type: "text", text: "thought-2" },
      ]);
    });

    it("REASONING_REDACTED appends a redacted entry", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "REASONING_REDACTED" });
      expect(s.messages[1].reasoning).toEqual([{ type: "redacted", data: "" }]);
    });
  });

  describe("STEP_START / STEP_FINISH", () => {
    it("creates a step row at the given index, idempotent on repeat", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "STEP_START", index: 0, stepType: "initial" });
      s = chatReducer(s, { type: "STEP_START", index: 0, stepType: "initial" }); // idempotent
      expect(s.messages[1].steps).toHaveLength(1);
      expect(s.messages[1].steps[0]).toMatchObject({
        index: 0,
        stepType: "initial",
        toolCalls: [],
        toolResults: [],
        done: false,
      });
    });

    it("STEP_FINISH marks the step as done with finishReason", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "STEP_START", index: 0, stepType: "initial" });
      s = chatReducer(s, { type: "STEP_FINISH", index: 0, finishReason: "stop" });
      expect(s.messages[1].steps[0]).toMatchObject({ done: true, finishReason: "stop" });
    });
  });

  describe("TOOL_CALL / TOOL_RESULT", () => {
    it("attaches tool calls to the most recent step", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "STEP_START", index: 0, stepType: "tool-result" });
      s = chatReducer(s, { type: "TOOL_CALL", id: "c1", name: "search", args: { q: "x" } });
      expect(s.messages[1].steps[0].toolCalls).toEqual([
        { toolCallId: "c1", toolName: "search", args: { q: "x" } },
      ]);
    });

    it("attaches tool result to the step holding the matching toolCallId", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "STEP_START", index: 0, stepType: "tool-result" });
      s = chatReducer(s, { type: "TOOL_CALL", id: "c1", name: "search", args: {} });
      s = chatReducer(s, { type: "STEP_START", index: 1, stepType: "continue" });
      s = chatReducer(s, { type: "TOOL_RESULT", id: "c1", result: "ok" });
      expect(s.messages[1].steps[0].toolResults).toEqual([
        { toolCallId: "c1", result: "ok" },
      ]);
      expect(s.messages[1].steps[1].toolResults).toEqual([]);
    });
  });

  describe("STREAM_DONE / STREAM_ERROR", () => {
    it("STREAM_DONE marks the streaming assistant as not streaming and stamps createdAt", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "STREAM_DONE" });
      expect(s.isStreaming).toBe(false);
      expect(s.messages[1].isStreaming).toBe(false);
      expect(s.messages[1].createdAt).not.toBeNull();
    });

    it("STREAM_ERROR sets error and stops streaming flags", () => {
      let s = withAssistantMessage(createInitialState(SLUG));
      s = chatReducer(s, { type: "STREAM_ERROR", error: "boom" });
      expect(s.isStreaming).toBe(false);
      expect(s.error).toBe("boom");
      expect(s.messages[1].isStreaming).toBe(false);
    });
  });

  describe("LOAD_CONVERSATION", () => {
    it("maps persisted steps + reasoning into live shape", () => {
      const s = chatReducer(createInitialState(SLUG), {
        type: "LOAD_CONVERSATION",
        conversationId: "api-abc",
        instanceSlug: "x",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "answer",
            steps: [
              {
                index: 0,
                stepType: "initial",
                text: "",
                toolCalls: [{ toolCallId: "c1", toolName: "search", args: {} }],
                toolResults: [{ toolCallId: "c1", result: "ok" }],
                finishReason: "tool-calls",
                durationMs: 100,
              },
            ],
            reasoning: [{ type: "text", text: "th", signature: "sig" }],
            attachments: null,
            metadata: null,
            createdAt: "2026-01-01T00:00:00Z",
            promptTokens: null,
            completionTokens: null,
          },
        ],
      });
      expect(s.messages).toHaveLength(1);
      expect(s.messages[0].steps[0]).toMatchObject({
        index: 0,
        toolCalls: [{ toolCallId: "c1", toolName: "search", args: {} }],
        toolResults: [{ toolCallId: "c1", result: "ok" }],
        done: true,
      });
      expect(s.messages[0].reasoning).toEqual([
        { type: "text", text: "th", signature: "sig" },
      ]);
      expect(s.chatId).toBe("abc"); // strips api- prefix
      expect(s.instanceSlug).toBe("x");
    });

    it("handles messages without steps/reasoning (legacy)", () => {
      const s = chatReducer(createInitialState(SLUG), {
        type: "LOAD_CONVERSATION",
        conversationId: "api-x",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "x",
            steps: null,
            reasoning: null,
            attachments: null,
            metadata: null,
            createdAt: null,
            promptTokens: null,
            completionTokens: null,
          },
        ],
      });
      expect(s.messages[0].steps).toEqual([]);
      expect(s.messages[0].reasoning).toEqual([]);
    });
  });
});
