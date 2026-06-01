// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { parseSseEvent, dispatch } from "./stream-parser";
import type { StreamCallbacks } from "./stream-parser";

function makeCallbacks(): StreamCallbacks & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => calls.push([name, args]);
  return {
    calls,
    onTextDelta: record("textDelta") as StreamCallbacks["onTextDelta"],
    onReasoningDelta: record("reasoningDelta") as StreamCallbacks["onReasoningDelta"],
    onReasoningSignature: record("reasoningSignature") as StreamCallbacks["onReasoningSignature"],
    onReasoningRedacted: record("reasoningRedacted") as StreamCallbacks["onReasoningRedacted"],
    onStepStart: record("stepStart") as StreamCallbacks["onStepStart"],
    onStepFinish: record("stepFinish") as StreamCallbacks["onStepFinish"],
    onToolCall: record("toolCall") as StreamCallbacks["onToolCall"],
    onToolResult: record("toolResult") as StreamCallbacks["onToolResult"],
    onDone: record("done") as StreamCallbacks["onDone"],
    onError: record("error") as StreamCallbacks["onError"],
  };
}

describe("parseSseEvent", () => {
  it("parses event + data correctly", () => {
    const raw = `event: text-delta\ndata: {"text":"hello"}`;
    expect(parseSseEvent(raw)).toEqual({
      event: "text-delta",
      data: { text: "hello" },
    });
  });

  it("defaults event name to 'message' when missing", () => {
    expect(parseSseEvent(`data: {"x":1}`)).toEqual({ event: "message", data: { x: 1 } });
  });

  it("returns null when data line is missing", () => {
    expect(parseSseEvent(`event: foo`)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseSseEvent(`event: x\ndata: not-json`)).toBeNull();
  });
});

describe("dispatch", () => {
  it("step-start invokes onStepStart with index + stepType", () => {
    const cb = makeCallbacks();
    dispatch({ event: "step-start", data: { index: 0, stepType: "initial" } }, cb);
    expect(cb.calls).toEqual([["stepStart", [0, "initial"]]]);
  });

  it("text-delta invokes onTextDelta with text", () => {
    const cb = makeCallbacks();
    dispatch({ event: "text-delta", data: { text: "abc" } }, cb);
    expect(cb.calls).toEqual([["textDelta", ["abc"]]]);
  });

  it("reasoning-delta invokes onReasoningDelta with text", () => {
    const cb = makeCallbacks();
    dispatch({ event: "reasoning-delta", data: { text: "thinking" } }, cb);
    expect(cb.calls).toEqual([["reasoningDelta", ["thinking"]]]);
  });

  it("reasoning-signature invokes onReasoningSignature when present", () => {
    const cb = makeCallbacks();
    dispatch({ event: "reasoning-signature", data: { signature: "sig" } }, cb);
    expect(cb.calls).toEqual([["reasoningSignature", ["sig"]]]);
  });

  it("reasoning-redacted invokes onReasoningRedacted with no args", () => {
    const cb = makeCallbacks();
    dispatch({ event: "reasoning-redacted", data: {} }, cb);
    expect(cb.calls).toEqual([["reasoningRedacted", []]]);
  });

  it("tool-call requires id and name; missing fields are dropped", () => {
    const cb = makeCallbacks();
    dispatch({ event: "tool-call", data: { id: "c1", name: "search", args: { q: "x" } } }, cb);
    dispatch({ event: "tool-call", data: { id: "", name: "search" } }, cb);
    expect(cb.calls).toEqual([["toolCall", ["c1", "search", { q: "x" }]]]);
  });

  it("tool-result attaches result by id", () => {
    const cb = makeCallbacks();
    dispatch({ event: "tool-result", data: { id: "c1", result: { ok: true } } }, cb);
    expect(cb.calls).toEqual([["toolResult", ["c1", { ok: true }]]]);
  });

  it("done invokes onDone and signals stop (returns false)", () => {
    const cb = makeCallbacks();
    const cont = dispatch({ event: "done", data: {} }, cb);
    expect(cont).toBe(false);
    expect(cb.calls).toEqual([["done", []]]);
  });

  it("error invokes onError with Error and signals stop", () => {
    const cb = makeCallbacks();
    const cont = dispatch({ event: "error", data: { message: "bad" } }, cb);
    expect(cont).toBe(false);
    expect(cb.calls[0][0]).toBe("error");
    const err = (cb.calls[0][1] as unknown[])[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("bad");
  });

  it("unknown event types are ignored without throwing", () => {
    const cb = makeCallbacks();
    expect(dispatch({ event: "weird", data: {} }, cb)).toBe(true);
    expect(cb.calls).toEqual([]);
  });

  it("models a realistic step lifecycle in order", () => {
    const cb = makeCallbacks();
    dispatch({ event: "step-start", data: { index: 0, stepType: "initial" } }, cb);
    dispatch({ event: "tool-call", data: { id: "c1", name: "search", args: {} } }, cb);
    dispatch({ event: "tool-result", data: { id: "c1", result: "ok" } }, cb);
    dispatch({ event: "step-finish", data: { index: 0, finishReason: "tool-calls" } }, cb);
    dispatch({ event: "step-start", data: { index: 1, stepType: "continue" } }, cb);
    dispatch({ event: "text-delta", data: { text: "answer" } }, cb);
    dispatch({ event: "step-finish", data: { index: 1, finishReason: "stop" } }, cb);
    dispatch({ event: "done", data: {} }, cb);

    expect(cb.calls.map(([name]) => name)).toEqual([
      "stepStart",
      "toolCall",
      "toolResult",
      "stepFinish",
      "stepStart",
      "textDelta",
      "stepFinish",
      "done",
    ]);
  });
});

describe("smoke: makeCallbacks does not require real fetch", () => {
  it("makeCallbacks returns all expected handlers", () => {
    const cb = makeCallbacks();
    expect(typeof cb.onTextDelta).toBe("function");
    expect(typeof cb.onReasoningDelta).toBe("function");
    expect(typeof cb.onStepStart).toBe("function");
    expect(typeof cb.onStepFinish).toBe("function");
    expect(typeof cb.onToolCall).toBe("function");
    expect(typeof cb.onToolResult).toBe("function");
    expect(typeof cb.onDone).toBe("function");
    expect(typeof cb.onError).toBe("function");
    // Suppress vi unused-import lint
    vi.fn();
  });
});
