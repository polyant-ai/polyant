// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import { extractText, MAX_TEXT_CHARS, MAX_TEXT_PARTS } from "./a2a-context.js";

describe("extractText", () => {
  it("should_join_text_parts_and_ignore_non_text", () => {
    const msg = {
      messageId: "m1",
      role: "user",
      parts: [
        { content: { $case: "text", value: "Hello " } },
        { content: { $case: "url", value: "x" } },
        { content: { $case: "text", value: "world" } },
      ],
    } as unknown as Message;
    expect(extractText(msg)).toBe("Hello world");
  });

  it("should_return_empty_string_when_no_text_parts", () => {
    const msg = { messageId: "m1", role: "user", parts: [] } as unknown as Message;
    expect(extractText(msg)).toBe("");
  });

  it("should_cap_the_total_length_at_MAX_TEXT_CHARS", () => {
    const msg = {
      messageId: "m1",
      role: "user",
      parts: [
        { content: { $case: "text", value: "a".repeat(MAX_TEXT_CHARS) } },
        { content: { $case: "text", value: "b".repeat(1000) } },
      ],
    } as unknown as Message;
    const out = extractText(msg);
    expect(out).toHaveLength(MAX_TEXT_CHARS);
    expect(out).not.toContain("b");
  });

  it("should_cap_the_number_of_text_parts_at_MAX_TEXT_PARTS", () => {
    const parts = Array.from({ length: MAX_TEXT_PARTS + 10 }, () => ({ content: { $case: "text", value: "x" } }));
    const msg = { messageId: "m1", role: "user", parts } as unknown as Message;
    expect(extractText(msg)).toHaveLength(MAX_TEXT_PARTS);
  });
});
