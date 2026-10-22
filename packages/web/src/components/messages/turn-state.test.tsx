// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Context section of the Debug sheet: which state it finds in the captured
 * request, and how it lays the fields out.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TurnState, extractTurnState, humanizeKey } from "./turn-state";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));

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

describe("humanizeKey", () => {
  it("splits snake, kebab and camel case into a sentence", () => {
    expect(humanizeKey("appointment_date")).toBe("Appointment date");
    expect(humanizeKey("customerName")).toBe("Customer name");
    expect(humanizeKey("lead-score")).toBe("Lead score");
  });
});

describe("TurnState", () => {
  it("renders labelled fields, nested objects and lists", () => {
    render(
      <TurnState
        state={{
          customer_name: "Ada",
          confirmed: true,
          notes: null,
          tags: ["vip", "returning"],
          clinic: { city: "Torino" },
        }}
      />,
    );
    expect(screen.getByText("Customer name")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("message.debug.stateYes")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("vip")).toBeTruthy();
    expect(screen.getByText("City")).toBeTruthy();
    expect(screen.getByText("Torino")).toBeTruthy();
  });
});
