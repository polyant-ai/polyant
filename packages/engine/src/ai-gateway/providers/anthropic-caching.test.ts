// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { anthropicStepMarker, applyAnthropicPromptCaching } from "./anthropic.js";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
// The within-turn step marker uses the DEFAULT 5-minute TTL (no `ttl` field), not 1h —
// see EPHEMERAL_STEP_CACHE_CONTROL in anthropic.ts.
const STEP_EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

function cacheControlOf(message: unknown): unknown {
  return (message as { providerOptions?: Record<string, unknown> }).providerOptions;
}

describe("applyAnthropicPromptCaching", () => {
  it("returns the system as marked instructions, never as a message", () => {
    const { instructions, messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6",
      system: "SYSTEM PROMPT",
      messages: [{ role: "user", content: "hi" }],
    });

    // The breakpoint rides on the system message handed to `instructions`.
    // Prepending it to `messages` is what AI SDK 7 rejects outright, so this
    // assertion is what keeps the cache marker and the call both working.
    expect(instructions).toMatchObject({ role: "system", content: "SYSTEM PROMPT" });
    expect(cacheControlOf(instructions)).toEqual(EPHEMERAL);
    expect(messages.some((m) => m.role === "system")).toBe(false);
  });

  it("does not set a history breakpoint on a single-turn conversation", () => {
    const { instructions, messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6",
      system: "S",
      messages: [{ role: "user", content: "first turn" }],
    });

    // Only the instructions carry a breakpoint; the lone user turn does not.
    expect(messages).toHaveLength(1);
    expect(cacheControlOf(instructions)).toEqual(EPHEMERAL);
    expect(cacheControlOf(messages[0])).toBeUndefined();
  });

  it("sets a breakpoint on the last history message from the 2nd turn onward", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "turn 2 (current)" },
    ];
    const { messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6", system: "S", messages: history });

    // messages = [user1, assistant1, user2] — the system is no longer prepended.
    expect(messages).toHaveLength(3);
    // assistant1 (the last history message) is marked; the current user turn is not.
    const assistant1 = messages[1];
    const currentTurn = messages[2];
    expect(assistant1).toMatchObject({ role: "assistant", content: "reply 1" });
    expect(cacheControlOf(assistant1)).toEqual(EPHEMERAL);
    expect(cacheControlOf(currentTurn)).toBeUndefined();
  });

  it("still applies the history breakpoint when there is no system prompt", () => {
    const { instructions, messages } = applyAnthropicPromptCaching({ modelId: "claude-sonnet-4-6",
      system: undefined,
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b (current)" },
      ],
    });

    expect(instructions).toBeUndefined();
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

  it("defaults the cross-turn breakpoint to the 1h TTL when ttl is omitted", () => {
    const { instructions } = applyAnthropicPromptCaching({
      modelId: "claude-sonnet-4-6",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(cacheControlOf(instructions)).toEqual(EPHEMERAL); // 1h
  });

  it("uses the 5m TTL on the cross-turn breakpoint when ttl='5m'", () => {
    const { instructions } = applyAnthropicPromptCaching({
      modelId: "claude-sonnet-4-6",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      ttl: "5m",
    });
    expect(cacheControlOf(instructions)).toEqual(STEP_EPHEMERAL); // 5m, no ttl field
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

  it("marks the last message from step 1 at the 5m within-turn TTL, leaving earlier messages untouched", () => {
    const out = anthropicStepMarker({ stepNumber: 1, messages, modelId: "claude-sonnet-4-6" }).messages;
    expect(out).toBeDefined();
    // Within-turn marker is 5m (default), NOT the cross-turn 1h: a 1h step marker
    // would overpay the write and — landing after the 1h system/history breakpoints —
    // would violate Anthropic's "longer TTL first" ordering.
    expect(cacheControlOf(out![out!.length - 1])).toEqual(STEP_EPHEMERAL);
    expect(cacheControlOf(out![out!.length - 1])).not.toEqual(EPHEMERAL);
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
