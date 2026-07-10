// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { anthropicStepMarker, applyAnthropicPromptCaching } from "./anthropic.js";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };

function cacheControlOf(message: ModelMessage): unknown {
  return (message as { providerOptions?: Record<string, unknown> }).providerOptions;
}

describe("applyAnthropicPromptCaching", () => {
  it("moves system into a leading system message carrying the ephemeral breakpoint", () => {
    const { system, messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6",
      system: "SYSTEM PROMPT",
      messages: [{ role: "user", content: "hi" }],
    });

    // Top-level system is cleared — it now lives as the first message.
    expect(system).toBeUndefined();
    expect(messages[0]).toMatchObject({ role: "system", content: "SYSTEM PROMPT" });
    expect(cacheControlOf(messages[0])).toEqual(EPHEMERAL);
  });

  it("does not set a history breakpoint on a single-turn conversation", () => {
    const { messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6",
      system: "S",
      messages: [{ role: "user", content: "first turn" }],
    });

    // [systemMessage, userTurn] — only the system carries a breakpoint.
    expect(messages).toHaveLength(2);
    expect(cacheControlOf(messages[0])).toEqual(EPHEMERAL);
    expect(cacheControlOf(messages[1])).toBeUndefined();
  });

  it("sets a breakpoint on the last history message from the 2nd turn onward", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "turn 2 (current)" },
    ];
    const { messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6", system: "S", messages: history });

    // messages = [systemMessage, user1, assistant1, user2]
    expect(messages).toHaveLength(4);
    // assistant1 (the last history message) is marked; the current user turn is not.
    const assistant1 = messages[2];
    const currentTurn = messages[3];
    expect(assistant1).toMatchObject({ role: "assistant", content: "reply 1" });
    expect(cacheControlOf(assistant1)).toEqual(EPHEMERAL);
    expect(cacheControlOf(currentTurn)).toBeUndefined();
  });

  it("still applies the history breakpoint when there is no system prompt", () => {
    const { system, messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6",
      system: undefined,
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b (current)" },
      ],
    });

    expect(system).toBeUndefined();
    // No system message prepended; breakpoint on the first (last-history) message.
    expect(messages).toHaveLength(2);
    expect(cacheControlOf(messages[0])).toEqual(EPHEMERAL);
    expect(cacheControlOf(messages[1])).toBeUndefined();
  });

  it("preserves pre-existing providerOptions when adding the breakpoint", () => {
    const { messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6",
      system: undefined,
      messages: [
        {
          role: "user",
          content: "a",
          providerOptions: { anthropic: { other: true } },
        } as ModelMessage,
        { role: "user", content: "b" },
      ],
    });

    expect(cacheControlOf(messages[0])).toEqual({
      anthropic: { other: true, cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });

  it("does not mutate the input messages array", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    const snapshot = JSON.stringify(input);
    applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6", system: "S", messages: input });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("anthropicStepMarker (multi-step prepareStep)", () => {
  // Content shape is irrelevant to a message-level marker; these stand in for the
  // user turn + accumulating assistant/tool-result messages of an agentic loop.
  const messages: ModelMessage[] = [
    { role: "user", content: "turn" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "tool result stand-in" },
  ];

  it("does not mark on step 0 (initial turn carries the volatile context tail)", () => {
    const result = anthropicStepMarker({ stepNumber: 0, messages, modelId: "claude-sonnet-4-6" });
    expect(result.messages).toBeUndefined();
  });

  it("marks the last message from step 1 onward, leaving earlier messages untouched", () => {
    const out = anthropicStepMarker({ stepNumber: 1, messages, modelId: "claude-sonnet-4-6" }).messages;
    expect(out).toBeDefined();
    expect(cacheControlOf(out![out!.length - 1])).toEqual(EPHEMERAL);
    expect(cacheControlOf(out![0])).toBeUndefined();
    expect(cacheControlOf(out![1])).toBeUndefined();
  });

  it("returns no messages for an empty array", () => {
    expect(anthropicStepMarker({ stepNumber: 2, messages: [], modelId: "claude-sonnet-4-6" }).messages).toBeUndefined();
  });

  it("does not mutate the input messages array", () => {
    const snapshot = JSON.stringify(messages);
    anthropicStepMarker({ stepNumber: 1, messages, modelId: "claude-sonnet-4-6" });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
