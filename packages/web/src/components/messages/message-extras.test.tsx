// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageExtras } from "./message-extras";
import { HookExecutionPill } from "./hook-execution-pill";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({
    locale: "it",
    setLocale: vi.fn(),
    t: (key: string) => ({
      "message.activity.called": "Chiamato",
      "message.activity.executed": "Eseguito",
      "message.activity.onEvent": "su evento",
      "message.reasoning.label": "Ragionamento",
      "message.steps.args": "Argomenti",
      "message.steps.result": "Risultato",
    })[key] ?? key,
  }),
}));

describe("conversation activity", () => {
  it("renders one expandable row per tool without inventing a timestamp or completion status", () => {
    render(<MessageExtras reasoning={[{ type: "text", text: "Valuto la richiesta" }]} steps={[{
      index: 0,
      stepType: "initial",
      text: "",
      toolCalls: [{ toolCallId: "call-1", toolName: "search", args: { query: "test" } }],
      toolResults: [],
    }]} />);

    expect(screen.getByText("Ragionamento")).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.queryByLabelText("message.activity.succeeded")).not.toBeInTheDocument();
    expect(screen.queryByRole("time")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("search"));
    expect(screen.getByText(/"query": "test"/)).toBeInTheDocument();
  });

  it("renders hooks as a static row with the recorded event", () => {
    render(<HookExecutionPill execution={{ event: "message_received", toolName: "refresh", success: true, durationMs: 25 }} timestamp="27 set 2026, 10:00" />);
    expect(screen.getByText("refresh")).toBeInTheDocument();
    expect(screen.getByText("message_received")).toBeInTheDocument();
    expect(screen.getByText("27 set 2026, 10:00")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
