// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageExtras } from "./message-extras";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string, params?: Record<string, string | number>) => {
      let s = key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
  }),
}));

describe("MessageExtras", () => {
  it("renders nothing when both reasoning and steps are absent", () => {
    const { container } = render(<MessageExtras reasoning={null} steps={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when both arrays are empty", () => {
    const { container } = render(<MessageExtras reasoning={[]} steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the reasoning panel when reasoning is non-empty", () => {
    render(
      <MessageExtras
        reasoning={[{ type: "text", text: "thinking…" }]}
        steps={null}
      />,
    );
    // Trigger label uses the i18n key (mocked passthrough)
    expect(screen.getByText("message.reasoning.label")).toBeInTheDocument();
  });

  it("renders the steps panel when at least one step has tool calls", () => {
    render(
      <MessageExtras
        reasoning={null}
        steps={[
          {
            index: 0,
            stepType: "tool-result",
            text: "",
            toolCalls: [{ toolCallId: "c1", toolName: "search", args: {} }],
            finishReason: "tool-calls",
            durationMs: 100,
          },
        ]}
      />,
    );
    // Label uses count interpolation: "message.steps.label" with {count}=1
    expect(screen.getByText("message.steps.label")).toBeInTheDocument();
  });

  it("hides steps panel when all steps have empty toolCalls (terminal-only turn)", () => {
    // Single-step no-tool turn: SDK emits one terminal step whose content is
    // already shown in the bubble — the panel should be suppressed.
    const { container } = render(
      <MessageExtras
        reasoning={null}
        steps={[
          {
            index: 0,
            stepType: "initial",
            text: "the answer",
            toolCalls: [],
            finishReason: "stop",
            durationMs: 0,
          },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("filters out empty terminal step when other steps have tool calls", () => {
    render(
      <MessageExtras
        reasoning={null}
        steps={[
          {
            index: 0,
            stepType: "tool-result",
            text: "",
            toolCalls: [{ toolCallId: "c1", toolName: "search", args: {} }],
            finishReason: "tool-calls",
            durationMs: 50,
          },
          {
            index: 1,
            stepType: "continue",
            text: "final answer",
            toolCalls: [],
            finishReason: "stop",
            durationMs: 50,
          },
        ]}
      />,
    );
    // Only the tool-call step should be rendered (count=1, not 2)
    expect(screen.getByText("message.steps.label")).toBeInTheDocument();
  });

  it("renders both panels when both are present", () => {
    render(
      <MessageExtras
        reasoning={[{ type: "text", text: "th" }]}
        steps={[
          {
            index: 0,
            stepType: "tool-result",
            text: "",
            toolCalls: [{ toolCallId: "c1", toolName: "search", args: {} }],
            finishReason: "tool-calls",
            durationMs: 0,
          },
        ]}
      />,
    );
    expect(screen.getByText("message.reasoning.label")).toBeInTheDocument();
    expect(screen.getByText("message.steps.label")).toBeInTheDocument();
  });
});
