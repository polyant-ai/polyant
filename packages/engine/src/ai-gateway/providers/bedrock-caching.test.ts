// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { applyBedrockPromptCaching } from "./bedrock.js";

const CACHE_POINT = { bedrock: { cachePoint: { type: "default" } } };

function providerOptionsOf(message: ModelMessage): unknown {
  return (message as { providerOptions?: Record<string, unknown> }).providerOptions;
}

describe("applyBedrockPromptCaching", () => {
  it("injects a cachePoint on system + last history for a cache-capable Claude model", () => {
    const { system, messages } = applyBedrockPromptCaching({
      modelId: "eu.anthropic.claude-sonnet-4-6",
      system: "SYSTEM PROMPT",
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "turn 2 (current)" },
      ],
    });

    expect(system).toBeUndefined();
    // [systemMessage, user1, assistant1, user2]
    expect(messages[0]).toMatchObject({ role: "system", content: "SYSTEM PROMPT" });
    expect(providerOptionsOf(messages[0])).toEqual(CACHE_POINT);
    // assistant1 (last history) is marked; the current turn is not.
    expect(providerOptionsOf(messages[2])).toEqual(CACHE_POINT);
    expect(providerOptionsOf(messages[3])).toBeUndefined();
  });

  it("also caches for an Amazon Nova model", () => {
    const { messages } = applyBedrockPromptCaching({
      modelId: "eu.amazon.nova-lite-v1:0",
      system: "S",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(providerOptionsOf(messages[0])).toEqual(CACHE_POINT);
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
    const { system, messages } = applyBedrockPromptCaching(input);

    // System stays top-level, no system message prepended, no markers anywhere.
    expect(system).toBe("S");
    expect(messages).toHaveLength(2);
    expect(providerOptionsOf(messages[0])).toBeUndefined();
    expect(providerOptionsOf(messages[1])).toBeUndefined();
  });

  it("does not set a history breakpoint on a single-turn conversation", () => {
    const { messages } = applyBedrockPromptCaching({
      modelId: "eu.anthropic.claude-opus-4-8",
      system: "S",
      messages: [{ role: "user", content: "first turn" }],
    });
    expect(messages).toHaveLength(2); // [systemMessage, userTurn]
    expect(providerOptionsOf(messages[0])).toEqual(CACHE_POINT);
    expect(providerOptionsOf(messages[1])).toBeUndefined();
  });
});
