// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { applyBedrockPromptCaching, bedrockStepMarker } from "./bedrock.js";

const CACHE_POINT = { bedrock: { cachePoint: { type: "default" } } };

function providerOptionsOf(message: unknown): unknown {
  return (message as { providerOptions?: Record<string, unknown> }).providerOptions;
}

describe("applyBedrockPromptCaching", () => {
  it("injects a cachePoint on system + last history for a cache-capable Claude model", () => {
    const { instructions, messages } = applyBedrockPromptCaching({
      modelId: "eu.anthropic.claude-sonnet-4-6",
      system: "SYSTEM PROMPT",
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "turn 2 (current)" },
      ],
    });

    // The cachePoint rides on the system message handed to `instructions`;
    // prepending it to `messages` is what AI SDK 7 rejects.
    expect(instructions).toMatchObject({ role: "system", content: "SYSTEM PROMPT" });
    expect(providerOptionsOf(instructions)).toEqual(CACHE_POINT);
    expect(messages.some((m) => m.role === "system")).toBe(false);
    // [user1, assistant1, user2] — assistant1 (last history) is marked; the
    // current turn is not.
    expect(messages).toHaveLength(3);
    expect(providerOptionsOf(messages[1])).toEqual(CACHE_POINT);
    expect(providerOptionsOf(messages[2])).toBeUndefined();
  });

  it("also caches for an Amazon Nova model", () => {
    const { instructions } = applyBedrockPromptCaching({
      modelId: "eu.amazon.nova-lite-v1:0",
      system: "S",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(providerOptionsOf(instructions)).toEqual(CACHE_POINT);
  });

  it("passes non-cache-capable models through untouched (no ValidationException risk)", () => {
    const input = {
      modelId: "qwen.qwen3-32b-v1:0",
      system: "S",
      messages: [
        { role: "user" as const, content: "a" },
        { role: "user" as const, content: "b (current)" },
      ],
    };
    const { instructions, messages } = applyBedrockPromptCaching(input);

    // System passes through as a plain string, no markers anywhere.
    expect(instructions).toBe("S");
    expect(messages).toHaveLength(2);
    expect(providerOptionsOf(messages[0])).toBeUndefined();
    expect(providerOptionsOf(messages[1])).toBeUndefined();
  });

  it("does not set a history breakpoint on a single-turn conversation", () => {
    const { instructions, messages } = applyBedrockPromptCaching({
      modelId: "eu.anthropic.claude-opus-4-8",
      system: "S",
      messages: [{ role: "user", content: "first turn" }],
    });
    expect(messages).toHaveLength(1); // [userTurn] — the system is not prepended
    expect(providerOptionsOf(instructions)).toEqual(CACHE_POINT);
    expect(providerOptionsOf(messages[0])).toBeUndefined();
  });
});

describe("bedrockStepMarker (multi-step prepareStep)", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "turn" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "tool result stand-in" },
  ];

  it("does not mark on step 0", () => {
    expect(
      bedrockStepMarker({ stepNumber: 0, messages, modelId: "eu.anthropic.claude-sonnet-4-6" }).messages,
    ).toBeUndefined();
  });

  it("marks the last message from step 1 for a cache-capable model", () => {
    const out = bedrockStepMarker({ stepNumber: 1, messages, modelId: "eu.anthropic.claude-sonnet-4-6" }).messages;
    expect(out).toBeDefined();
    expect(providerOptionsOf(out![out!.length - 1])).toEqual(CACHE_POINT);
    expect(providerOptionsOf(out![0])).toBeUndefined();
  });

  it("does not mark a non-cache-capable model even at step >= 1 (no ValidationException risk)", () => {
    expect(
      bedrockStepMarker({ stepNumber: 2, messages, modelId: "qwen.qwen3-32b-v1:0" }).messages,
    ).toBeUndefined();
  });
});
