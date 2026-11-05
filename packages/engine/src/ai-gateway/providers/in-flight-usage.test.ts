// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";

// The tracing wrapper, minus the tracing: the real AI SDK underneath, so the
// model-call callbacks fire exactly as they do in production.
vi.mock("../langsmith.js", async () => {
  const ai = await import("ai");
  return { tracedGenerateText: ai.generateText, tracedStreamText: ai.streamText };
});

import { MockLanguageModelV4 } from "ai/test";
import { APICallError, jsonSchema, tool, type Tool } from "ai";
import { createProvider, usageCompletedBeforeFailure } from "./base.js";
import type { ChatRequest } from "../types.js";

// A model call the caller aborts while it is in flight has already reached the
// provider, which processes and bills the prompt, but no usage ever comes back.

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const usage = (input: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
});

async function failedCall(
  model: MockLanguageModelV4,
  controller: AbortController,
  tools?: Record<string, Tool>,
  messages: ChatRequest["messages"] = [{ role: "user", content: "hello" }],
) {
  const provider = createProvider("anthropic", () => model);
  const system = "S".repeat(4_000);
  try {
    await provider.chat(
      { tier: "standard", system, messages, abortSignal: controller.signal, maxSteps: 5, tools, cacheConfig: { enabled: false, ttl: "1h" } },
      "claude-sonnet-4-6",
    );
  } catch (err) {
    return usageCompletedBeforeFailure(err);
  }
  throw new Error("the call was expected to fail");
}

describe("a model call aborted in flight", () => {
  it("pins an estimate of the prompt it had sent, when no call had answered yet", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        setTimeout(() => controller.abort(), 5);
        return waitForAbort(options.abortSignal);
      },
    });

    const pinned = await failedCall(model, controller);

    expect(pinned?.calls).toEqual([]);
    // About a token per four characters of a 4,000-character system prompt.
    expect(pinned?.inFlight?.promptTokens).toBeGreaterThan(900);
    expect(pinned?.inFlight?.promptTokens).toBeLessThan(1_200);
  });

  it("pins the answered call's usage and the in-flight call's estimate", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "tool-call", toolCallId: "t1", toolName: "search", input: "{}" }],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: usage(38_000),
            warnings: [],
          };
        }
        setTimeout(() => controller.abort(), 5);
        return waitForAbort(options.abortSignal);
      },
    });
    const tools = { search: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => ({ found: [] }) }) };

    const pinned = await failedCall(model, controller, tools);

    expect(calls).toBe(2);
    expect(pinned?.promptTokens).toBe(38_000);
    expect(pinned?.calls).toHaveLength(1);
    expect(pinned?.inFlight?.promptTokens).toBeGreaterThan(900);
  });

  it("counts an attached image and file as a few thousand tokens, whatever their size in bytes", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        setTimeout(() => controller.abort(), 5);
        return waitForAbort(options.abortSignal);
      },
    });
    const photo = Buffer.alloc(3 * 1024 * 1024, 7);
    const document = Buffer.alloc(10 * 1024 * 1024, 7);

    const pinned = await failedCall(model, controller, undefined, [
      {
        role: "user",
        content: [
          { type: "text", text: "what do these say?" },
          { type: "image", image: photo, mediaType: "image/jpeg" },
          { type: "file", data: document, mediaType: "application/pdf" },
        ],
      },
    ]);

    // The 4,000-character system prompt (about 1,000 tokens) plus two
    // attachments; serialized as bytes they came to millions.
    expect(pinned?.inFlight?.promptTokens).toBeGreaterThan(1_500);
    expect(pinned?.inFlight?.promptTokens).toBeLessThan(10_000);
  });

  it("pins no in-flight estimate when the abort lands while a refused request waits to be retried", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        // The provider refused the request: it billed nothing, and the SDK
        // waits before the retry, which the abort cuts short.
        setTimeout(() => controller.abort(), 5);
        throw new APICallError({ message: "overloaded", url: "https://provider.test", requestBodyValues: {}, statusCode: 529, isRetryable: true });
      },
    });

    const pinned = await failedCall(model, controller);

    expect(pinned?.inFlight).toBeUndefined();
  });

  it("pins the estimate again once the retried request is in flight", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        attempts += 1;
        if (attempts === 1) {
          throw new APICallError({ message: "overloaded", url: "https://provider.test", requestBodyValues: {}, statusCode: 529, isRetryable: true });
        }
        setTimeout(() => controller.abort(), 5);
        return waitForAbort(options.abortSignal);
      },
    });

    const pinned = await failedCall(model, controller);

    expect(attempts).toBe(2);
    expect(pinned?.inFlight?.promptTokens).toBeGreaterThan(900);
  });

  it("pins no in-flight estimate when every call that started had answered", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "tool-call", toolCallId: "t1", toolName: "book", input: "{}" }],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage(38_000),
        warnings: [],
      }),
    });
    // The abort lands while the tool runs: the next model call never starts.
    const tools = {
      book: tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          controller.abort();
          return { ok: true };
        },
      }),
    };

    const pinned = await failedCall(model, controller, tools);

    expect(pinned?.promptTokens).toBe(38_000);
    expect(pinned?.inFlight).toBeUndefined();
  });
});
