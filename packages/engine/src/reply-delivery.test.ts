// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { resolveDeliveredReply } from "./reply-delivery.js";

describe("resolveDeliveredReply", () => {
  it("persists the tool replyText and suppresses delivery when a tool handled the reply", () => {
    const r = resolveDeliveredReply({ replyHandled: true, replyText: "List body\n[Button: A]", llmText: "ignored" });
    expect(r.persistText).toBe("List body\n[Button: A]");
    expect(r.toolDelivered).toBe(true);
  });

  it("falls back to the LLM text when a tool handled the reply but supplied no replyText", () => {
    const r = resolveDeliveredReply({ replyHandled: true, replyText: "", llmText: "llm text" });
    expect(r.persistText).toBe("llm text");
    expect(r.toolDelivered).toBe(true);
  });

  it("uses the LLM text for both persistence and delivery when no tool handled the reply", () => {
    const r = resolveDeliveredReply({ replyHandled: false, llmText: "llm text" });
    expect(r.persistText).toBe("llm text");
    expect(r.toolDelivered).toBe(false);
  });
});
