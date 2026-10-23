// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chatStream` over the real AI SDK `streamText` and a mock model: how often the
 * model stream is split, and that the turn settles whatever its reader does.
 * Every getter of an SDK 7 stream result splits (`tee()`) the stream and every
 * chunk is copied into each branch, so which getters the provider touches is a
 * per-token cost; and the turn must still run to the end and settle when the
 * reader stops early, stops pulling, or never reads (a client that went away).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// The tracing wrapper, minus the tracing: the real AI SDK underneath.
vi.mock("../langsmith.js", async () => {
  const ai = await import("ai");
  return { tracedGenerateText: ai.generateText, tracedStreamText: ai.streamText };
});

import { MockLanguageModelV4 } from "ai/test";
import { createProvider } from "./base.js";

interface Script {
  /** Pause after the first text delta until this settles. */
  hold?: Promise<void>;
  /** Break the model stream after the first text delta. */
  fail?: Error;
}

/** A model that streams reasoning, then three text deltas and a finish, following `script`. */
function mockModel(script: Script = {}) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "reasoning-start", id: "r" });
          controller.enqueue({ type: "reasoning-delta", id: "r", delta: "pensando" });
          controller.enqueue({ type: "reasoning-end", id: "r" });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "uno " });
          await script.hold;
          if (script.fail) {
            controller.error(script.fail);
            return;
          }
          controller.enqueue({ type: "text-delta", id: "t", delta: "due " });
          controller.enqueue({ type: "text-delta", id: "t", delta: "tre" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 3, text: 3, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

/** One streamed turn through the provider, as the gateway starts it. */
function startTurn(script?: Script, abortSignal?: AbortSignal) {
  const model = mockModel(script);
  return createProvider("test", () => model as never).chatStream!(
    { tier: "standard", messages: [{ role: "user", content: "ciao" }], ...(abortSignal ? { abortSignal } : {}) },
    "mock",
  );
}

/** The promise, or a rejection if it has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms)),
  ]);
}

const textOf = (part: unknown): string | undefined => {
  const p = part as { type?: string; text?: string };
  return p.type === "text-delta" ? p.text : undefined;
};

/** Read up to the first text delta; returns its text. */
async function nextText(reader: AsyncIterator<unknown>): Promise<string | undefined> {
  for (let r = await reader.next(); !r.done; r = await reader.next()) {
    const t = textOf(r.value);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** Read to the end; the part types seen, and what the read threw, if anything. */
async function drain(reader: AsyncIterator<unknown>): Promise<{ types: string[]; threw?: unknown }> {
  const types: string[] = [];
  try {
    for (let r = await reader.next(); !r.done; r = await reader.next()) types.push((r.value as { type: string }).type);
  } catch (threw) {
    return { types, threw };
  }
  return { types };
}

/** A gate the test opens by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chatStream over the real SDK", () => {
  it("splits the model stream once per turn", async () => {
    const tee = vi.spyOn(ReadableStream.prototype, "tee");
    const stream = await startTurn();
    for await (const _part of stream.fullStream) { void _part; }
    await stream.response;

    expect(tee).toHaveBeenCalledTimes(1);
  });

  it("hands the reader every part in order and settles the response from the finished turn", async () => {
    const stream = await startTurn();
    const texts: string[] = [];
    for await (const part of stream.fullStream) {
      const t = textOf(part);
      if (t !== undefined) texts.push(t);
    }
    const response = await stream.response;

    expect(texts).toEqual(["uno ", "due ", "tre"]);
    expect(response.text).toBe("uno due tre");
    expect(response.usage).toMatchObject({ promptTokens: 7, completionTokens: 3 });
    expect(JSON.stringify(response.reasoning)).toContain("pensando");
  });

  // In the three cases below the provider's own read finishes the turn, so the
  // stream is still split once: the result's getters (a new split each) are
  // not needed to rescue it.
  it("settles the response at once when nobody reads the stream", async () => {
    const tee = vi.spyOn(ReadableStream.prototype, "tee");
    const stream = await startTurn();

    const response = await within(stream.response, 500);

    expect(response.text).toBe("uno due tre");
    expect(tee).toHaveBeenCalledTimes(1);
  });

  it("runs the turn to the end after the reader stops early", async () => {
    const tee = vi.spyOn(ReadableStream.prototype, "tee");
    const model = gate();
    const stream = await startTurn({ hold: model.opened });
    for await (const part of stream.fullStream) {
      if (textOf(part) !== undefined) break;
    }
    model.open();

    const response = await within(stream.response);

    expect(response.text).toBe("uno due tre");
    expect(tee).toHaveBeenCalledTimes(1);
  });

  it("runs the turn to the end when the reader stops pulling without returning", async () => {
    const tee = vi.spyOn(ReadableStream.prototype, "tee");
    const model = gate();
    const stream = await startTurn({ hold: model.opened });
    const reader = stream.fullStream[Symbol.asyncIterator]();
    await reader.next();
    model.open();

    const response = await within(stream.response);

    expect(response.text).toBe("uno due tre");
    expect(tee).toHaveBeenCalledTimes(1);
  });

  it("still yields the text on textStream to a reader that asks for it", async () => {
    const stream = await startTurn();
    let text = "";
    for await (const chunk of stream.textStream) text += chunk;

    expect(text).toBe("uno due tre");
    expect((await stream.response).text).toBe("uno due tre");
  });

  it("fails the response when the model stream breaks mid-turn", async () => {
    const model = gate();
    const broken = new Error("connection reset");
    const stream = await startTurn({ hold: model.opened, fail: broken });
    const reader = stream.fullStream[Symbol.asyncIterator]();
    const first = await nextText(reader);
    model.open();
    const rest = await drain(reader);

    expect(first).toBe("uno ");
    // The reader fails with the model's own error, and so does the response.
    expect(rest.threw).toBe(broken);
    await expect(within(stream.response)).rejects.toBe(broken);
  });

  it("settles an aborted turn instead of leaving it pending", async () => {
    const model = gate();
    const abort = new AbortController();
    const stream = await startTurn({ hold: model.opened }, abort.signal);
    const reader = stream.fullStream[Symbol.asyncIterator]();
    const first = await nextText(reader);
    abort.abort();
    model.open();
    const rest = await drain(reader);

    expect(first).toBe("uno ");
    // The SDK ends the stream with an `abort` part; the response rejects with the abort.
    expect(rest).toEqual({ types: ["abort"] });
    await expect(within(stream.response)).rejects.toMatchObject({ name: "AbortError" });
  });
});
