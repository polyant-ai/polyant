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

  // Nova is cache-capable, so the gate above lets it through — the refusal is
  // narrower: LIVE-VERIFIED 400 "extraneous key [cachePoint] is not permitted"
  // on a message carrying tool content. That is exactly the message this moving
  // marker lands on, so a Nova agent broke on its FIRST tool call while every
  // tool-less turn cached fine.
  const toolMessages: ModelMessage[] = [
    { role: "user", content: "turn" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "writeFile", input: {} }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "t1", toolName: "writeFile", output: { type: "text", value: "ok" } },
      ],
    },
  ];

  it("leaves a tool-result message unmarked on Nova, and still marks it on Claude", () => {
    const nova = bedrockStepMarker({ stepNumber: 1, messages: toolMessages, modelId: "eu.amazon.nova-pro-v1:0" }).messages;
    expect(providerOptionsOf(nova![nova!.length - 1])).toBeUndefined();

    const claude = bedrockStepMarker({ stepNumber: 1, messages: toolMessages, modelId: "eu.anthropic.claude-sonnet-4-6" }).messages;
    expect(providerOptionsOf(claude![claude!.length - 1])).toEqual(CACHE_POINT);
  });

  it("still marks a text-only message on Nova — the system prefix keeps caching", () => {
    const out = bedrockStepMarker({ stepNumber: 1, messages, modelId: "eu.amazon.nova-pro-v1:0" }).messages;
    expect(providerOptionsOf(out![out!.length - 1])).toEqual(CACHE_POINT);
  });
});

describe("Bedrock cache points across a multi-step turn", () => {
  const modelId = "eu.anthropic.claude-sonnet-4-6";
  const isMarked = (m: unknown) => providerOptionsOf(m) !== undefined;

  function toolStep(n: number): ModelMessage[] {
    const id = `t${n}`;
    return [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "lookup", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName: "lookup", output: { type: "text", value: "ok" } }],
      },
    ];
  }

  // The SDK feeds the messages `prepareStep` returned into the next step, so a
  // marker that never moves accumulates: instructions + history + three step
  // markers is five, and Bedrock answers 400 above four.
  it("keeps a turn with history, instructions and three tool steps at four cache points or fewer", () => {
    const first = applyBedrockPromptCaching({
      modelId,
      system: "SYSTEM",
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "turn 2 (current)" },
      ],
    });
    let messages = first.messages;
    for (let step = 1; step <= 3; step++) {
      messages = [...messages, ...toolStep(step)];
      messages = bedrockStepMarker({ stepNumber: step, messages, modelId }).messages!;
      const total = (isMarked(first.instructions) ? 1 : 0) + messages.filter(isMarked).length;
      expect(total).toBeLessThanOrEqual(4);
    }

    expect(providerOptionsOf(first.instructions)).toEqual(CACHE_POINT);
    // History marker stays; only the newest step carries the moving one.
    expect(providerOptionsOf(messages[1])).toEqual(CACHE_POINT);
    expect(providerOptionsOf(messages[messages.length - 1])).toEqual(CACHE_POINT);
    expect(messages.slice(2, -1).filter(isMarked)).toHaveLength(0);
  });

  it("removes only the cache point when moving it, keeping other provider options", () => {
    const withOther: ModelMessage = {
      role: "assistant",
      content: "earlier step",
      providerOptions: { bedrock: { cachePoint: { type: "default" }, other: 1 }, openai: { x: 2 } },
    };
    const out = bedrockStepMarker({
      stepNumber: 2,
      messages: [{ role: "user", content: "turn" }, withOther, { role: "assistant", content: "latest" }],
      modelId,
    }).messages!;
    expect(providerOptionsOf(out[1])).toEqual({ bedrock: { other: 1 }, openai: { x: 2 } });
    expect(providerOptionsOf(out[2])).toEqual(CACHE_POINT);
  });
});

describe("applyBedrockPromptCaching on Nova", () => {
  it("marks the system prompt but skips a tool-call message in history", () => {
    const { instructions, messages } = applyBedrockPromptCaching({
      modelId: "eu.amazon.nova-pro-v1:0",
      system: "SYSTEM PROMPT",
      messages: [
        { role: "user", content: "turn 1" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "t1", toolName: "writeFile", input: {} }],
        },
        { role: "user", content: "turn 2 (current)" },
      ],
    });

    expect(providerOptionsOf(instructions)).toEqual(CACHE_POINT);
    expect(providerOptionsOf(messages[1])).toBeUndefined();
  });
});
