// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure formatter tests. These were inherited from the deleted
 * `real-events.test.ts` (PII-redaction allow-list per tool) and extended
 * with cases for `formatReasoning` and `truncate` since both are now
 * directly exported.
 */

import { describe, it, expect } from "vitest";
import {
  formatReasoning,
  summarizeArgs,
  truncate,
  REDACTED_PLACEHOLDER,
} from "./event-formatters.js";

describe("summarizeArgs", () => {
  it("returns empty string for non-object args", () => {
    expect(summarizeArgs("anyTool", null)).toBe("");
    expect(summarizeArgs("anyTool", "x")).toBe("");
    expect(summarizeArgs("anyTool", 42)).toBe("");
  });

  describe("HubSpot allow-list", () => {
    it("hubspotContact: action + first/last name", () => {
      expect(
        summarizeArgs("hubspotContact", { action: "create", firstName: "Mario", lastName: "Rossi" }),
      ).toBe("create Mario Rossi");
    });

    it("hubspotDeal: action + dealName", () => {
      expect(summarizeArgs("hubspotDeal", { action: "update", dealName: "Q3 deal" })).toBe(
        "update Q3 deal",
      );
    });

    it("hubspotSendEmail: subject only", () => {
      expect(summarizeArgs("hubspotSendEmail", { subject: "Welcome", body: "secret body" })).toBe(
        "Welcome",
      );
    });
  });

  describe("knowledge / search tools: query only", () => {
    it("searchKnowledge", () => {
      expect(summarizeArgs("searchKnowledge", { query: "pricing", filter: "x" })).toBe("pricing");
    });
    it("webSearch", () => {
      expect(summarizeArgs("webSearch", { query: "openai gpt-5" })).toBe("openai gpt-5");
    });
  });

  describe("dev lifecycle tools", () => {
    it("readFile: path", () => {
      expect(summarizeArgs("readFile", { path: "src/index.ts" })).toBe("src/index.ts");
    });
    it("httpRequest: method + url", () => {
      expect(summarizeArgs("httpRequest", { method: "POST", url: "https://api.example.com/x" })).toBe(
        "POST https://api.example.com/x",
      );
    });
    it("slackPostMessage: channel only (body redacted)", () => {
      expect(summarizeArgs("slackPostMessage", { channel: "#alerts", message: "secret" })).toBe(
        "#alerts",
      );
    });
  });

  describe("fallback (unknown tool)", () => {
    it("emits up to 3 top-level key=value pairs", () => {
      expect(summarizeArgs("unknownTool", { a: 1, b: 2, c: 3, d: 4 })).toBe("a=1 b=2 c=3");
    });
    it("returns empty when no keys", () => {
      expect(summarizeArgs("unknownTool", {})).toBe("");
    });
    it("redacts values for keys that look like PII (token, password, …)", () => {
      const out = summarizeArgs("unknownTool", {
        username: "mario",
        password: "s3cret",
        apiToken: "abc123",
      });
      expect(out).toContain('username="mario"');
      expect(out).not.toContain("s3cret");
      expect(out).not.toContain("abc123");
      expect(out).toContain("password=<string>");
      expect(out).toContain("apiToken=<string>");
    });
  });

  it("truncates summaries with ellipsis past the per-tool max", () => {
    const longName = "x".repeat(200);
    const out = summarizeArgs("hubspotContact", { action: "create", firstName: longName });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatReasoning", () => {
  it("returns empty string for empty array", () => {
    expect(formatReasoning([])).toBe("");
  });

  it("joins text blocks with spaces", () => {
    expect(
      formatReasoning([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });

  it("substitutes redacted blocks with the placeholder", () => {
    expect(
      formatReasoning([
        { type: "text", text: "Pre" },
        { type: "redacted", data: "XXXX" },
        { type: "text", text: "Post" },
      ]),
    ).toBe(`Pre ${REDACTED_PLACEHOLDER} Post`);
  });

  it("truncates long output", () => {
    const longText = "a".repeat(500);
    const out = formatReasoning([{ type: "text", text: longText }]);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("truncate", () => {
  it("returns the string verbatim under cap", () => {
    expect(truncate("hello", 80)).toBe("hello");
  });
  it("appends ellipsis when over cap", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
  });
});
