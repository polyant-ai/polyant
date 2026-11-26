// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownRenderer } from "./messages/markdown-renderer";
import { LiveTurn } from "./messages/live-turn";
import { MessageBubble } from "./playground/message-bubble";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));

// `data-private` tells session-replay and analytics tools to leave an element alone.
// Removing it from a component that renders message content silently leaks that content.
describe("data-private", () => {
  it("marks the root of MarkdownRenderer", () => {
    const { container } = render(<MarkdownRenderer content="hello" />);
    expect(container.firstElementChild).toHaveAttribute("data-private");
  });

  it("marks the root of MessageBubble", () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: "m1",
          role: "user",
          content: "hello",
          steps: [],
          reasoning: [],
          hookExecutions: [],
          isStreaming: false,
          createdAt: null,
        }}
        showActivity={false}
      />,
    );
    expect(container.firstElementChild).toHaveAttribute("data-private");
  });

  it("marks the root of LiveTurn", () => {
    const { container } = render(
      <LiveTurn
        events={[{ id: "in", ts: "2026-09-27T10:00:00.000Z", persona: "agent", category: "inbound", text: "chat: hi", responsePreview: "hi" }]}
        showActivity={false}
      />,
    );
    expect(container.firstElementChild).toHaveAttribute("data-private");
  });
});
