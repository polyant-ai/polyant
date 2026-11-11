// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { streamBufferedTurn } from "./buffered-turn-stream.js";
import type { ToolObserver } from "./channels/types.js";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** A turn whose steps the test releases one at a time. */
function steppedTurn() {
  let observer!: ToolObserver;
  let finish!: (text: string) => void;
  let fail!: (err: Error) => void;
  const run = (o: ToolObserver) => {
    observer = o;
    return new Promise<{ text: string }>((resolve, reject) => {
      finish = (text) => resolve({ text });
      fail = reject;
    });
  };
  return { run, observer: () => observer, finish: (t: string) => finish(t), fail: (e: Error) => fail(e) };
}

describe("streamBufferedTurn", () => {
  it("streams each tool as it happens, before the turn has finished", async () => {
    const turn = steppedTurn();
    const pending = streamBufferedTurn(turn.run);
    turn.observer().onToolCall({ toolCallId: "c1", toolName: "search", input: { q: "x" } });
    const { fullStream } = await pending;
    const reader = fullStream[Symbol.asyncIterator]();

    await expect(reader.next()).resolves.toEqual({
      done: false,
      value: { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } },
    });
    // The result arrives while the stream is already waiting for it.
    const next = reader.next();
    turn.observer().onToolResult({ toolCallId: "c1", output: { hits: 1 } });
    await expect(next).resolves.toEqual({ done: false, value: { type: "tool-result", toolCallId: "c1", output: { hits: 1 } } });

    turn.finish("the reply");
    await expect(collect({ [Symbol.asyncIterator]: () => reader })).resolves.toEqual([{ type: "text-delta", text: "the reply" }]);
  });

  it("delivers a turn without tools as its reply alone", async () => {
    const { fullStream, textStream, turn } = await streamBufferedTurn(async () => ({ text: "hello" }));
    expect(await collect(fullStream)).toEqual([{ type: "text-delta", text: "hello" }]);
    expect(await collect(textStream)).toEqual(["hello"]);
    await expect(turn).resolves.toEqual({ text: "hello" });
  });

  it("fails where it always did when the turn fails before any tool", async () => {
    await expect(streamBufferedTurn(async () => { throw new Error("no model"); })).rejects.toThrow("no model");
  });

  it("ends the stream with the failure when the turn fails after a tool was shown", async () => {
    const turn = steppedTurn();
    const pending = streamBufferedTurn(turn.run);
    turn.observer().onToolCall({ toolCallId: "c1", toolName: "search", input: {} });
    const { fullStream } = await pending;
    turn.fail(new Error("provider down"));

    const seen: unknown[] = [];
    await expect((async () => { for await (const part of fullStream) seen.push(part); })()).rejects.toThrow("provider down");
    expect(seen).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "search", input: {} }]);
  });
});
