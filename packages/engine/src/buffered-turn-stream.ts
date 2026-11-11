// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolObserver } from "./channels/types.js";

/** A buffered turn served on a streaming route. */
export interface BufferedTurnStream<T> {
  /** The turn's tool calls and results as they happen, then its reply as one text part. */
  fullStream: AsyncIterable<unknown>;
  /** The reply, in one piece, once the turn has finished. */
  textStream: AsyncIterable<string>;
  /** The finished turn. */
  turn: Promise<T>;
}

/**
 * Run a buffered turn and stream what can be shown before its reply is final.
 *
 * A turn whose reply is settled only after the model (a hook that may replace
 * it, an output check that may redact it) cannot stream its text. Its tools are
 * a different matter: what they were called with and what they returned is
 * known as it happens, and nothing after the model changes it. So the tool
 * parts are delivered live, in the shape of the AI SDK full stream, and the
 * reply follows as a single text part.
 *
 * Resolves at the turn's first tool call, or when the turn ends if it calls
 * none, so a turn that fails before doing anything still fails here, where the
 * caller has always received that failure. A failure after a tool has been
 * shown ends the streams with it.
 */
export async function streamBufferedTurn<T extends { text: string }>(
  run: (observer: ToolObserver) => Promise<T>,
): Promise<BufferedTurnStream<T>> {
  const parts: unknown[] = [];
  let wake: (() => void) | undefined;
  let firstPart!: () => void;
  const started = new Promise<void>((resolve) => { firstPart = resolve; });
  const push = (part: unknown) => {
    parts.push(part);
    firstPart();
    wake?.();
  };

  const turn = run({
    onToolCall: ({ toolCallId, toolName, input }) => push({ type: "tool-call", toolCallId, toolName, input }),
    onToolResult: ({ toolCallId, output }) => push({ type: "tool-result", toolCallId, output }),
  });
  let settled = false;
  const settle = () => {
    settled = true;
    wake?.();
  };
  // Handled here so a caller that never reads the streams does not leave the
  // turn's failure unhandled; the streams below still throw it.
  turn.then(settle, settle);

  await Promise.race([started, turn]);

  const fullStream = (async function* () {
    for (;;) {
      if (parts.length > 0) {
        yield parts.shift();
        continue;
      }
      if (settled) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    const { text } = await turn;
    yield { type: "text-delta", text };
  })();

  return {
    fullStream,
    textStream: (async function* () { yield (await turn).text; })(),
    turn,
  };
}
