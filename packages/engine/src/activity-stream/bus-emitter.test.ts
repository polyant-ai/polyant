// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Smoke tests for the bus emitter producers.
 *
 * Two scenarios:
 *   - `tapAndForwardFullStream`: feed a synthetic SDK fullStream and assert
 *     the right FeedEvents land on the bus, with the spotlight payload
 *     populated (argsPreview, resultPreview, status, durationMs,
 *     conversationId).
 *   - `emitFromChatResponse`: feed a synthetic ChatResponse and assert the
 *     same shape end-to-end.
 *
 * Both rely on the real ActivityBus singleton — we just attach a listener
 * for the duration of each test and detach in `afterEach`.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { activityBus } from "./activity-bus.js";
import {
  emitFromChatResponse,
  tapAndForwardFullStream,
  type BusContext,
} from "./bus-emitter.js";
import type { FeedEvent } from "./activity-stream.types.js";
import type { ChatResponse } from "../ai-gateway/types.js";

const ctx: BusContext = {
  conversationId: "conv-1",
  instance: { id: "inst-1", slug: "alpha", name: "Alpha", icon: null },
};

function captureEvents(): { events: FeedEvent[]; stop: () => void } {
  const events: FeedEvent[] = [];
  const stop = activityBus.subscribe((e) => events.push(e));
  return { events, stop };
}

let teardown: (() => void) | null = null;
beforeEach(() => {
  // Clear the bus ring buffer so each test sees only its own events.
  activityBus.__clearBuffer();
});
afterEach(() => {
  teardown?.();
  teardown = null;
});

async function* fromArray(chunks: Array<Record<string, unknown>>) {
  for (const c of chunks) yield c;
}

describe("tapAndForwardFullStream", () => {
  it("forwards every chunk to the consumer untouched", async () => {
    const cap = captureEvents();
    teardown = cap.stop;
    const stream = fromArray([
      { type: "step-start" },
      { type: "text-delta", textDelta: "hi" },
      { type: "step-finish", finishReason: "stop" },
    ]);

    const seen: unknown[] = [];
    for await (const chunk of tapAndForwardFullStream(stream, ctx)) {
      seen.push(chunk);
    }
    expect(seen).toHaveLength(3);
    expect((seen[1] as { type: string }).type).toBe("text-delta");
  });

  it("does NOT emit tool events from SDK chunks (the supervisor wrapper owns those)", async () => {
    const cap = captureEvents();
    teardown = cap.stop;
    const stream = fromArray([
      { type: "step-start" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "webSearch",
        args: { query: "openai gpt-5" },
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "webSearch",
        result: { results: [{ title: "GPT-5 launches" }] },
      },
      { type: "step-finish", finishReason: "tool-calls" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of tapAndForwardFullStream(stream, ctx)) { /* drain */ }

    // No `tool` field on any emitted event — the SDK chunk tap does not
    // surface tool calls as activity events.
    expect(cap.events.every((e) => e.tool === undefined)).toBe(true);
  });

  it("does NOT emit turn-started or turn-completed markers", async () => {
    const cap = captureEvents();
    teardown = cap.stop;
    const stream = fromArray([
      { type: "step-start" },
      { type: "text-delta", textDelta: "ok" },
      { type: "step-finish", finishReason: "stop" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of tapAndForwardFullStream(stream, ctx)) { /* drain */ }

    const ids = cap.events.map((e) => e.id);
    expect(ids.some((id) => id.endsWith(":turn-started"))).toBe(false);
    expect(ids.some((id) => id.endsWith(":turn-completed"))).toBe(false);
  });

  it("aggregates reasoning into a single thinking event at step-finish", async () => {
    const cap = captureEvents();
    teardown = cap.stop;
    const stream = fromArray([
      { type: "step-start" },
      { type: "reasoning", textDelta: "First " },
      { type: "reasoning", textDelta: "thought." },
      { type: "step-finish", finishReason: "stop" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of tapAndForwardFullStream(stream, ctx)) { /* drain */ }

    const think = cap.events.find((e) => e.persona === "thinking");
    expect(think).toBeDefined();
    expect(think!.text).toBe("First thought.");
    expect(think!.responsePreview).toBe("First thought.");
    expect(think!.conversationId).toBe("conv-1");
  });

  it("skips assistant text emission on intermediate steps (finishReason: tool-calls)", async () => {
    const cap = captureEvents();
    teardown = cap.stop;
    const stream = fromArray([
      { type: "step-start" },
      // Intermediate step text — junk like "[]" the model emits before a tool call.
      { type: "text-delta", textDelta: "[]" },
      { type: "step-finish", finishReason: "tool-calls" },
      // Real terminal step
      { type: "step-start" },
      { type: "text-delta", textDelta: "Final answer." },
      { type: "step-finish", finishReason: "stop" },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of tapAndForwardFullStream(stream, ctx)) { /* drain */ }

    const textEvents = cap.events.filter((e) => /:text:0$/.test(e.id));
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toBe("Final answer.");
  });

});

describe("emitFromChatResponse", () => {
  it("replays steps as a batch with one tool event per call (no synthetic start)", () => {
    const cap = captureEvents();
    teardown = cap.stop;

    const response: ChatResponse = {
      text: "ok",
      steps: [
        {
          index: 0,
          stepType: "tool-result",
          text: "",
          toolCalls: [{ toolCallId: "c1", toolName: "readFile", args: { path: "src/index.ts" } }],
          toolResults: [{ toolCallId: "c1", result: "file content" }],
          finishReason: "tool-calls",
          durationMs: 123,
        },
        {
          index: 1,
          stepType: "continue",
          text: "Final answer.",
          toolCalls: [],
          finishReason: "stop",
          durationMs: 50,
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      durationMs: 200,
      model: "gpt-4o",
      provider: "openai",
    };

    emitFromChatResponse(response, ctx);

    const ids = cap.events.map((e) => e.id);
    // Tool events are NOT emitted by the batch replay — only text/usage
    // events carry through this path.
    expect(cap.events.every((e) => e.tool === undefined)).toBe(true);
    expect(ids.some((id) => /:tool:/.test(id))).toBe(false);
    expect(ids.some((id) => /:s1:text:0$/.test(id))).toBe(true);
    // No turn markers any more.
    expect(ids.some((id) => id.endsWith(":turn-started"))).toBe(false);
    expect(ids.some((id) => id.endsWith(":turn-completed"))).toBe(false);

    const text = cap.events.find((e) => /:s1:text:0$/.test(e.id))!;
    expect(text.responsePreview).toBe("Final answer.");
  });

  it("does not emit text for intermediate steps (finishReason: tool-calls)", () => {
    const cap = captureEvents();
    teardown = cap.stop;

    const response: ChatResponse = {
      text: "Final.",
      steps: [
        {
          index: 0,
          stepType: "initial",
          text: "[]",
          toolCalls: [],
          finishReason: "tool-calls",
          durationMs: 50,
        },
        {
          index: 1,
          stepType: "continue",
          text: "Final.",
          toolCalls: [],
          finishReason: "stop",
          durationMs: 50,
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      durationMs: 100,
      model: "gpt-4o",
      provider: "openai",
    };

    emitFromChatResponse(response, ctx);

    const textEvents = cap.events.filter((e) => /:text:0$/.test(e.id));
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toBe("Final.");
  });

  it("does nothing for an empty steps array", () => {
    const cap = captureEvents();
    teardown = cap.stop;

    emitFromChatResponse(
      {
        text: "",
        steps: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        durationMs: 1,
        model: "x",
        provider: "openai",
      },
      ctx,
    );

    expect(cap.events).toHaveLength(0);
  });
});
