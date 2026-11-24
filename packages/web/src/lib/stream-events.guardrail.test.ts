// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat stream's event names are written twice: the engine's stream
 * controller sends them (`send("text-delta", …)`) and the panel's parser
 * switches on them. Nothing else ties the two, so an event renamed or added
 * on one side is dropped in silence by the other — the reply just stops
 * showing a part of itself.
 *
 * The engine side is read from its source (the names are string literals at
 * the call sites); the panel side is exercised: every event the engine sends
 * must make `dispatch` call back, or end the stream.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch, type StreamCallbacks } from "./stream-parser";

const CONTROLLER = join(
  __dirname,
  "../../../engine/src/server/openai/instance-chat-stream.controller.ts",
);

function engineEvents(): string[] {
  const source = readFileSync(CONTROLLER, "utf8");
  return [...new Set([...source.matchAll(/\bsend\(\s*"([a-z][a-z-]*)"/g)].map((m) => m[1]))].sort();
}

/** Callbacks that record which were called, whatever the parser's interface names them. */
function recordingCallbacks(): { cb: StreamCallbacks; called: string[] } {
  const called: string[] = [];
  const cb = new Proxy({} as StreamCallbacks, {
    get: (_target, name) => (..._args: unknown[]) => {
      called.push(String(name));
    },
  });
  return { cb, called };
}

describe("chat stream events", () => {
  const events = engineEvents();

  it("finds the events the engine sends", () => {
    // Non-vacuity: a moved controller would make every check below pass.
    expect(events).toEqual(expect.arrayContaining(["text-delta", "tool-call", "tool-result", "done"]));
  });

  it.each(events)("the panel handles the engine's %s event", (event) => {
    const { cb, called } = recordingCallbacks();
    // One payload with every field any event needs, shaped as the controller sends them.
    const data = {
      text: "x",
      index: 0,
      stepType: "initial",
      id: "t1",
      name: "tool",
      args: {},
      result: {},
      message: "boom",
      hookId: "h1",
      event: "message_received",
      toolName: "tool",
      success: true,
      durationMs: 1,
    };
    const keepReading = dispatch({ event, data }, cb);
    expect(called.length > 0 || keepReading === false, `${event} reached no callback and did not end the stream`).toBe(true);
  });

  it("handles no event the engine never sends", () => {
    const { cb, called } = recordingCallbacks();
    const keepReading = dispatch({ event: "not-an-engine-event", data: {} }, cb);
    // The probe above is only meaningful if an unknown event does nothing.
    expect(called).toEqual([]);
    expect(keepReading).toBe(true);
  });
});
