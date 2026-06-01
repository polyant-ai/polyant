// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { toSlackMrkdwn } from "./slack-mrkdwn.js";

describe("toSlackMrkdwn", () => {
  it("converts headings to bold", () => {
    expect(toSlackMrkdwn("# Title")).toBe("*Title*");
    expect(toSlackMrkdwn("## Section")).toBe("*Section*");
    expect(toSlackMrkdwn("### Sub")).toBe("*Sub*");
  });

  it("converts bold from double to single asterisk", () => {
    expect(toSlackMrkdwn("**bold text**")).toBe("*bold text*");
  });

  it("converts italic from asterisk to underscore", () => {
    expect(toSlackMrkdwn("*italic text*")).toBe("_italic text_");
  });

  it("converts strikethrough from double to single tilde", () => {
    expect(toSlackMrkdwn("~~deleted~~")).toBe("~deleted~");
  });

  it("preserves inline code", () => {
    expect(toSlackMrkdwn("use `npm install`")).toBe("use `npm install`");
  });

  it("converts code blocks without language tag", () => {
    const input = "```typescript\nconst x = 1;\n```";
    expect(toSlackMrkdwn(input)).toBe("```const x = 1;```");
  });

  it("converts markdown links to Slack format", () => {
    expect(toSlackMrkdwn("[click here](https://example.com)")).toBe(
      "<https://example.com|click here>",
    );
  });

  it("converts unordered lists to bullet points", () => {
    const input = "- item 1\n- item 2\n- item 3";
    expect(toSlackMrkdwn(input)).toBe("• item 1\n• item 2\n• item 3");
  });

  it("preserves ordered lists", () => {
    const input = "1. first\n2. second";
    expect(toSlackMrkdwn(input)).toBe("1. first\n2. second");
  });

  it("converts blockquotes", () => {
    expect(toSlackMrkdwn("> quoted text")).toBe(">quoted text");
  });

  it("strips horizontal rules", () => {
    expect(toSlackMrkdwn("above\n---\nbelow")).toBe("above\nbelow");
  });

  it("renders tables as monospace code blocks with column alignment", () => {
    const input = "| Name | Value |\n|------|-------|\n| foo  | 42    |";
    const result = toSlackMrkdwn(input);
    expect(result.startsWith("```\n")).toBe(true);
    expect(result.endsWith("\n```")).toBe(true);
    // Header + separator + row, each on its own line
    const body = result.slice(4, -4);
    const lines = body.split("\n");
    expect(lines).toHaveLength(3);
    // Header preserved
    expect(lines[0]).toMatch(/^Name\s+Value$/);
    // Separator made of dashes only
    expect(lines[1]).toMatch(/^-+\s+-+$/);
    // Data row preserved
    expect(lines[2]).toMatch(/^foo\s+42$/);
  });

  it("strips markdown markers inside table cells before laying out the code block", () => {
    const input = [
      "| Metric | Value |",
      "|--------|-------|",
      "| **Revenue** | [EUR 57.720](https://example.com) |",
    ].join("\n");
    const result = toSlackMrkdwn(input);
    // Markers must not appear inside the code block — they would render as
    // literal characters and break alignment.
    expect(result).not.toContain("**");
    expect(result).not.toContain("](");
    expect(result).toContain("Revenue");
    expect(result).toContain("EUR 57.720");
  });

  it("handles mixed formatting in one line", () => {
    const input = "This is **bold** and *italic* with `code`";
    expect(toSlackMrkdwn(input)).toBe("This is *bold* and _italic_ with `code`");
  });

  it("handles a full report-like message", () => {
    const input = [
      "## Daily Report — Activity Summary — 2026-04-15",
      "",
      "**RIEPILOGO:** Tutto nella norma",
      "",
      "**WARNING** (2)",
      "- `14:32` [core] — Timeout on API call (3 occorrenze)",
      "- `15:10` [analytics] — Missing credentials warning",
      "",
      "**DEPLOY** (1)",
      "- [core] feat: add feature — 10:08 — live",
    ].join("\n");

    const result = toSlackMrkdwn(input);
    // Heading → bold
    expect(result).toContain("*Daily Report — Activity Summary — 2026-04-15*");
    // Bold → single asterisk
    expect(result).toContain("*RIEPILOGO:* Tutto nella norma");
    // List → bullets
    expect(result).toContain("• `14:32` [core] — Timeout on API call (3 occorrenze)");
  });
});
