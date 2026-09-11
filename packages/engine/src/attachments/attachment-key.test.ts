// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { parseAttachmentKey } from "./attachment-key.js";

describe("parseAttachmentKey", () => {
  /*
    The shape the router actually produces. Every consumer had typed this
    `string`, so the key-shape regex was tested against "a,b,c,d" and could only
    fail — the download endpoint refused every attachment ever stored.
  */
  it("accepts the segment array the wildcard route produces", () => {
    const parsed = parseAttachmentKey(["attachments", "agent-a", "conv-1", "report.pdf"]);
    expect(parsed).toEqual({
      key: "attachments/agent-a/conv-1/report.pdf",
      agentSlug: "agent-a",
      conversationId: "conv-1",
      fileName: "report.pdf",
    });
  });

  it("accepts a plain string too, so the shape can change back", () => {
    expect(parseAttachmentKey("attachments/agent-a/conv-1/report.pdf")?.agentSlug).toBe("agent-a");
  });

  /*
    Validation is on the SEGMENTS. The router decodes each one before the handler
    sees it, so a segment can itself hold a separator or a traversal: recomposing
    first and pattern-matching after would read the `%2F` case as a well-formed
    four-segment key.
  */
  it.each([
    ["a separator smuggled into one segment", ["attachments", "agent-a", "conv-1", "a/b.pdf"]],
    ["a backslash smuggled into one segment", ["attachments", "agent-a", "conv-1", "a\\b.pdf"]],
    ["a traversal inside a segment", ["attachments", "agent-a", "conv-1", "..pdf"]],
    ["a traversal as a whole segment", ["attachments", "agent-a", "..", "f.pdf"]],
    ["an empty segment", ["attachments", "agent-a", "", "f.pdf"]],
    ["too few segments", ["attachments", "agent-a", "f.pdf"]],
    ["too many segments", ["attachments", "a", "c", "d", "f.pdf"]],
    ["the wrong prefix", ["uploads", "agent-a", "conv-1", "f.pdf"]],
    ["a non-string segment", ["attachments", "agent-a", "conv-1", 7]],
  ])("refuses %s", (_label, raw) => {
    expect(parseAttachmentKey(raw)).toBeNull();
  });

  it.each([[undefined], [null], [42], [{}]])("refuses the non-key %p", (raw) => {
    expect(parseAttachmentKey(raw)).toBeNull();
  });
});
