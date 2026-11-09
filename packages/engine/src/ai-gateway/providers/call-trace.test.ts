// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What one gateway call records for the request path: which step each request
 * to the provider belongs to (a retry stays on its step), what went out and came
 * back on success and on failure, and the timeline of steps and tool runs.
 */

import { describe, expect, it, vi } from "vitest";
import { callTimeline, exchangeRecorder, exchangesOf } from "./call-trace.js";

const params = (n: number) => ({ prompt: [{ role: "user", content: `turn ${n}` }] });

describe("exchangeRecorder", () => {
  it("numbers steps, and keeps a retry on the step it retries", () => {
    const rec = exchangeRecorder();
    rec.begin(false, params(1));
    rec.answered({ request: { body: '{"model":"m","n":1}' }, response: { body: { id: "r1" } } });
    rec.begin(false, params(2));
    rec.failed(Object.assign(new Error("429"), { statusCode: 429, requestBodyValues: { n: 2 }, responseBody: '{"error":"rate"}' }));
    rec.begin(true, params(2));
    rec.answered({ request: { body: '{"n":2}' } });

    expect(rec.list.map((e) => [e.stepIndex, e.attempt, e.status])).toEqual([
      [0, 1, 200],
      [1, 1, 429],
      [1, 2, 200],
    ]);
    // Bodies the adapter kept as JSON text come back parsed.
    expect(rec.list[0].request).toEqual({ model: "m", n: 1 });
    expect(rec.list[1]).toMatchObject({ request: { n: 2 }, response: { error: "rate" } });
  });

  it("keeps the provider-level prompt when the adapter reports no body", () => {
    const rec = exchangeRecorder();
    rec.begin(false, params(1));
    rec.answered({});
    expect(rec.list[0].request).toEqual({ prompt: params(1).prompt, tools: undefined });
  });

  it("fills a streamed step's answer from what the SDK assembled", () => {
    const rec = exchangeRecorder();
    rec.begin(false, params(1));
    rec.answered({ request: { body: "{}" } });
    rec.fillFromSteps([{ content: [{ type: "text", text: "hi" }], finishReason: "stop", usage: { inputTokens: 1 } }]);
    expect(rec.list[0].response).toEqual({ assembled: true, content: [{ type: "text", text: "hi" }], finishReason: "stop", usage: { inputTokens: 1 } });
  });

  it("travels on the error of a failed call", () => {
    const rec = exchangeRecorder();
    rec.begin(false, params(1));
    const err = new Error("boom");
    rec.failed(err);
    rec.pinTo(err);
    expect(exchangesOf(err)).toBe(rec.list);
    expect(exchangesOf(new Error("other"))).toBeUndefined();
  });
});

describe("callTimeline", () => {
  it("records when each step and each tool run started, and how long the run took", () => {
    vi.useFakeTimers({ now: 1_000 });
    const tl = callTimeline();
    tl.onStepStart({ stepNumber: 0 });
    vi.advanceTimersByTime(500);
    tl.onToolExecutionStart({ toolCall: { toolCallId: "tc-1" } });
    tl.onToolExecutionEnd({ toolCall: { toolCallId: "tc-1" }, toolExecutionMs: 212.6 });
    vi.advanceTimersByTime(100);
    tl.onStepStart({ stepNumber: 1 });
    vi.useRealTimers();

    expect(tl.stepStarts).toEqual([1_000, 1_600]);
    expect(tl.toolRuns.get("tc-1")).toEqual({ startedAt: 1_500, durationMs: 213 });
  });
});
