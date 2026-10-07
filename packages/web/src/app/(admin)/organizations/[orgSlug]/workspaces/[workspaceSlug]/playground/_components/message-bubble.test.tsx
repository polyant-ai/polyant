// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MessageBubble } from "./message-bubble";
import type { ChatMessage } from "../_hooks/use-chat";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en" }),
}));

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  role: "assistant",
  content: "Ho trovato tre orari",
  steps: [],
  reasoning: [],
  hookExecutions: [],
  isStreaming: false,
  createdAt: null,
  ...over,
});

describe("MessageBubble", () => {
  it("enters with an animation only when sent in this session, never when loaded", () => {
    const sent = render(<MessageBubble message={message({ sentHere: true })} showActivity={false} />);
    expect(sent.container.firstElementChild?.classList.contains("animate-conversation-enter")).toBe(true);

    const loaded = render(<MessageBubble message={message()} showActivity={false} />);
    expect(loaded.container.firstElementChild?.classList.contains("animate-conversation-enter")).toBe(false);
  });

  it("fades the words of a streaming reply in, and drops the spans once it is complete", () => {
    const streaming = render(<MessageBubble message={message({ isStreaming: true })} showActivity={false} />);
    expect(streaming.container.querySelectorAll(".stream-word").length).toBe(4);

    const done = render(<MessageBubble message={message()} showActivity={false} />);
    expect(done.container.querySelectorAll(".stream-word").length).toBe(0);
  });
});
