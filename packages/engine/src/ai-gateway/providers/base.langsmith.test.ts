// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chatStream` with LangSmith tracing on: the real `wrapAISDK` wrapper over the
 * real AI SDK and a mock model. The LangSmith client's run uploads are captured
 * instead of sent. The tracer reads the stream result on its own (its
 * `processOutputs` awaits `content` or `text`), so it adds branches to the model
 * stream; the turn must still hand the reader every part, settle its response
 * whatever the reader does, and leave a complete trace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "langsmith";
import { MockLanguageModelV4 } from "ai/test";
import { buildLangSmithProviderOptions } from "../langsmith.js";
import { createProvider } from "./base.js";

/** A model that streams reasoning, then three text deltas and a finish. */
function mockModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "reasoning-start", id: "r" });
          controller.enqueue({ type: "reasoning-delta", id: "r", delta: "pensando" });
          controller.enqueue({ type: "reasoning-end", id: "r" });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "uno " });
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

/** One traced streamed turn through the provider, with the options the gateway builds. */
function startTracedTurn() {
  const model = mockModel();
  const langsmith = buildLangSmithProviderOptions(
    { apiKey: "lsv2-test-key", project: "itest" },
    { conversationId: "c-1", instanceId: "agent-1" },
  );
  return createProvider("test", () => model as never).chatStream!(
    { tier: "standard", messages: [{ role: "user", content: "ciao" }], providerOptions: { langsmith } },
    "mock",
  );
}

/** The fields of a run payload these tests read. */
interface Upload {
  outputs?: unknown;
  error?: unknown;
}

/** Every run payload the client was asked to create or update, in order. */
let uploads: Upload[] = [];

beforeEach(() => {
  uploads = [];
  vi.spyOn(Client.prototype, "createRun").mockImplementation(async (run) => {
    uploads.push(run);
  });
  vi.spyOn(Client.prototype, "updateRun").mockImplementation(async (_id, run) => {
    uploads.push(run);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The finished runs: those that carry outputs or an error. */
const finishedRuns = () => uploads.filter((run) => run.outputs !== undefined || run.error !== undefined);

describe("chatStream with LangSmith tracing on", () => {
  it("hands the reader every part, settles the response and traces the turn's output", async () => {
    const stream = await startTracedTurn();
    const types: string[] = [];
    let text = "";
    for await (const part of stream.fullStream) {
      const p = part as { type: string; text?: string };
      types.push(p.type);
      if (p.type === "text-delta") text += p.text;
    }
    const response = await stream.response;

    expect(text).toBe("uno due tre");
    expect(types).toContain("reasoning-delta");
    expect(types.at(-1)).toBe("finish");
    expect(response.text).toBe("uno due tre");
    expect(response.usage).toMatchObject({ promptTokens: 7, completionTokens: 3 });

    await vi.waitFor(() => {
      const outputs = finishedRuns().map((run) => JSON.stringify(run.outputs));
      // The turn's run and the model call's child run both carry the answer.
      expect(outputs.filter((o) => o.includes("uno due tre")).length).toBeGreaterThanOrEqual(2);
    });
    expect(finishedRuns().filter((run) => run.error)).toEqual([]);
  });

  it("settles the response and the trace when nobody reads the stream", async () => {
    const stream = await startTracedTurn();
    const response = await Promise.race([
      stream.response,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("not settled within 1000 ms")), 1000)),
    ]);

    expect(response.text).toBe("uno due tre");
    await vi.waitFor(() => {
      const outputs = finishedRuns().map((run) => JSON.stringify(run.outputs));
      expect(outputs.filter((o) => o.includes("uno due tre")).length).toBeGreaterThanOrEqual(2);
    });
  });
});
