// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildMessagesWithReasoning } from "./reasoning-injector.js";
import type { MessageRow } from "../conversations/store.js";

function row(over: Partial<MessageRow>): MessageRow {
  return { role: "user", content: "", steps: null, reasoning: null, createdAt: null, ...over };
}

describe("buildMessagesWithReasoning", () => {
  it("returns plain CoreMessage for user/system rows regardless of provider/thinking", () => {
    const rows: MessageRow[] = [
      row({ role: "user", content: "hello" }),
      row({ role: "system", content: "you are X" }),
    ];
    const out = buildMessagesWithReasoning(rows, "anthropic", true);
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "system", content: "you are X" },
    ]);
  });

  it("returns plain assistant text when thinking is disabled", () => {
    const rows = [
      row({
        role: "assistant",
        content: "answer",
        reasoning: [{ type: "text", text: "thinking", signature: "sig" }],
      }),
    ];
    const out = buildMessagesWithReasoning(rows, "anthropic", false);
    expect(out).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("returns plain assistant text when provider is not anthropic", () => {
    const rows = [
      row({
        role: "assistant",
        content: "answer",
        reasoning: [{ type: "text", text: "thinking", signature: "sig" }],
      }),
    ];
    const out = buildMessagesWithReasoning(rows, "openai", true);
    expect(out).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("re-injects signed thinking blocks before the assistant text for anthropic+thinking", () => {
    const rows = [
      row({
        role: "assistant",
        content: "answer text",
        reasoning: [
          { type: "text", text: "thought-1", signature: "sig-1" },
          { type: "text", text: "thought-2", signature: "sig-2" },
        ],
      }),
    ];
    const out = buildMessagesWithReasoning(rows, "anthropic", true);
    expect(out).toHaveLength(1);
    const msg = out[0] as { role: string; content: unknown };
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "thought-1", signature: "sig-1" },
      { type: "thinking", thinking: "thought-2", signature: "sig-2" },
      { type: "text", text: "answer text" },
    ]);
  });

  it("skips reasoning blocks without signature (cannot be re-injected)", () => {
    const rows = [
      row({
        role: "assistant",
        content: "x",
        reasoning: [
          { type: "text", text: "unsigned" }, // no signature → skipped
          { type: "text", text: "signed", signature: "sig" },
          { type: "redacted", data: "blob" },  // not "text" → skipped
        ],
      }),
    ];
    const out = buildMessagesWithReasoning(rows, "anthropic", true);
    const msg = out[0] as { content: unknown };
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "signed", signature: "sig" },
      { type: "text", text: "x" },
    ]);
  });

  it("falls back to plain text assistant when reasoning array has no signed blocks", () => {
    const rows = [
      row({
        role: "assistant",
        content: "x",
        reasoning: [{ type: "text", text: "unsigned" }],
      }),
    ];
    const out = buildMessagesWithReasoning(rows, "anthropic", true);
    expect(out).toEqual([{ role: "assistant", content: "x" }]);
  });
});
