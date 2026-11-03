// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../utils/create-logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/create-logger.js")>()),
  createLogger: () => mockLog,
}));

const { AnthropicProvider } = await import("./anthropic.js");
import type { ChatRequest } from "../types.js";

// The real Anthropic SDK runs the call; only the network is stubbed. What is
// under test is what the provider does when the network misbehaves: a stream
// that stops sending mid-response, a call that never answers, a request that
// fails once and is retried.

const MODEL = "claude-sonnet-4-6";
const encoder = new TextEncoder();

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A stream that sends the start of an answer and then nothing more, without closing. */
function stalledStream(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse([
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      ])));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function okMessage(): Response {
  return new Response(
    JSON.stringify({
      id: "m", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A fetch that answers only when its caller gives up, as a hung connection does. */
function neverAnswers(_input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { tier: "standard", system: "S", messages: [{ role: "user", content: "hi" }], apiKeys: { anthropic: "test" }, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounds on a model call", () => {
  it("ends a streamed answer whose provider stops sending mid-response", async () => {
    vi.stubGlobal("fetch", async () => stalledStream());
    const stream = await AnthropicProvider.chatStream!(request({ timeout: { chunkMs: 200 }, maxRetries: 0 }), MODEL);

    const started = Date.now();
    await expect(stream.response).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("ends a call that never answers once its total time is up", async () => {
    vi.stubGlobal("fetch", neverAnswers);

    await expect(AnthropicProvider.chat(request({ timeout: { totalMs: 200 }, maxRetries: 0 }), MODEL))
      .rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("logs no error when its caller cancels the call, which is a routine path", async () => {
    vi.stubGlobal("fetch", neverAnswers);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(AnthropicProvider.chat(request({ abortSignal: controller.signal, maxRetries: 0 }), MODEL)).rejects.toThrow();
    const stream = await AnthropicProvider.chatStream!(request({ abortSignal: AbortSignal.abort(), maxRetries: 0 }), MODEL);
    await expect(stream.response).rejects.toThrow();

    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it("still logs a call its own deadline ended as an error", async () => {
    vi.stubGlobal("fetch", neverAnswers);

    await expect(AnthropicProvider.chat(request({ abortSignal: AbortSignal.timeout(20), maxRetries: 0 }), MODEL)).rejects.toThrow();

    expect(mockLog.error).toHaveBeenCalled();
  });

  it("retries a request that failed with a retryable error, and logs the retry", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), {
          status: 529,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        });
      }
      return okMessage();
    });

    const response = await AnthropicProvider.chat(request({ maxRetries: 1 }), MODEL);

    expect(response.text).toBe("ok");
    expect(calls).toBe(2);
    const retryLines = mockLog.warn.mock.calls.filter(([, msg]) => String(msg).includes("retry"));
    expect(retryLines).toHaveLength(1);
    expect(String(retryLines[0][1])).toContain(`anthropic/${MODEL}`);
    expect(String(retryLines[0][1])).toContain("overloaded");
  });

  it("makes no retry when told none", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), {
        status: 529,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    });

    await expect(AnthropicProvider.chat(request({ maxRetries: 0 }), MODEL)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
