// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import { extractText } from "./a2a-context.js";

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
});
