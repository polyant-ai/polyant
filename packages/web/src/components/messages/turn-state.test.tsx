// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Context tab of the Debug sheet: which state it finds in the captured
 * request.
 */

import { describe, it, expect } from "vitest";
import { extractTurnState } from "./turn-state";

function userTurn(state: unknown, words = "hello") {
  return {
    role: "user",
    content: [
      { type: "text", text: words },
      { type: "text", text: `<context>\n<conversation_state>${JSON.stringify(state)}</conversation_state>\n</context>` },
    ],
  };
}

describe("extractTurnState", () => {
  it("reads the state from the last user message, not from history", () => {
    const messages = [
      userTurn({ step: "old" }),
      { role: "assistant", content: "ok" },
      userTurn({ step: "new" }),
      { role: "tool", content: [{ type: "tool-result", output: "<conversation_state>{}</conversation_state>" }] },
    ];
    expect(extractTurnState(messages)).toEqual({ step: "new" });
  });

  it("reads a user message sent as a plain string", () => {
    const messages = [{ role: "user", content: `hi\n<context>\n<conversation_state>{"a":1}</conversation_state>\n</context>` }];
    expect(extractTurnState(messages)).toEqual({ a: 1 });
  });

  it("returns null when no block is present or the block does not parse", () => {
    expect(extractTurnState([{ role: "user", content: "hi" }])).toBeNull();
    expect(extractTurnState([{ role: "user", content: "<conversation_state>{nope</conversation_state>" }])).toBeNull();
    expect(extractTurnState([{ role: "user", content: "<conversation_state>[1]</conversation_state>" }])).toBeNull();
  });
});
