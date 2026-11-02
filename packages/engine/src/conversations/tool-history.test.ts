// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildHistoryWithToolResults, MAX_REPLAYED_RESULT_CHARS } from "./tool-history.js";
import type { MessageRow } from "./store.js";
import type { StepDetail } from "./schema.js";

function row(partial: Partial<MessageRow> & { role: string; content: string }): MessageRow {
  return { steps: null, reasoning: null, createdAt: null, ...partial };
}

function step(over: Partial<StepDetail> & Pick<StepDetail, "toolCalls">): StepDetail {
  return {
    index: 0,
    stepType: "initial",
    text: "",
    finishReason: "tool-calls",
    durationMs: 1,
    ...over,
  };
}

// Narrow the union ModelMessage content to the array-of-parts shape for assertions.
function parts(msg: unknown): Array<Record<string, unknown>> {
  return (msg as { content: Array<Record<string, unknown>> }).content;
}

describe("buildHistoryWithToolResults", () => {
  it("passes through user/system/plain-assistant rows as {role, content}", () => {
    const out = buildHistoryWithToolResults([
      row({ role: "user", content: "hi" }),
      row({ role: "assistant", content: "hello" }), // no steps
      row({ role: "system", content: "sys" }),
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "sys" },
    ]);
  });

  it("reconstructs tool-call + tool-result for a tool-using assistant turn", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "Found contact 123.",
        steps: [
          step({
            toolCalls: [{ toolCallId: "c1", toolName: "lookupContact", args: { action: "search" } }],
            toolResults: [{ toolCallId: "c1", result: { contactId: "123" } }],
          }),
        ],
      }),
    ]);

    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c1", toolName: "lookupContact", input: { action: "search" } },
      ],
    });
    expect(out[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "lookupContact",
          output: { type: "text", value: JSON.stringify({ contactId: "123" }) },
        },
      ],
    });
    expect(out[2]).toEqual({ role: "assistant", content: "Found contact 123." });
  });

  // The stored reply is written after the tools return. Replayed ahead of the
  // calls, it reads as an answer given before the tool ran, and on the next turn
  // a live model told the user it had answered without checking, or had never
  // made a call it did make.
  it("replays the stored reply after the tool results, in the order the turn ran", () => {
    const out = buildHistoryWithToolResults([
      row({ role: "user", content: "Read the returns policy." }),
      row({
        role: "assistant",
        content: "Returns are accepted within 30 days.",
        steps: [
          step({
            toolCalls: [{ toolCallId: "c1", toolName: "readSkill", args: { name: "returns-policy" } }],
            toolResults: [{ toolCallId: "c1", result: { found: true } }],
          }),
          step({ index: 1, text: "Returns are accepted within 30 days.", toolCalls: [], finishReason: "stop" }),
        ],
      }),
      row({ role: "user", content: "And for electronics?" }),
    ]);

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(parts(out[1]).map((p) => p.type)).toEqual(["tool-call"]);
    expect(out[3]).toEqual({ role: "assistant", content: "Returns are accepted within 30 days." });
  });

  // A response hook can rewrite the reply before it is stored (a masked phone
  // number, a removed tag). The replay carries what was stored, never the raw
  // text a step produced.
  it("replays the stored reply, not a step's raw text", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "Your contact is on file.",
        steps: [
          step({ toolCalls: [{ toolCallId: "c1", toolName: "lookupContact", args: {} }], toolResults: [{ toolCallId: "c1", result: "ok" }] }),
          step({ index: 1, text: "Your contact is +39 333 1234567.", toolCalls: [], finishReason: "stop" }),
        ],
      }),
    ]);

    expect(JSON.stringify(out)).not.toContain("1234567");
    expect(out.at(-1)).toEqual({ role: "assistant", content: "Your contact is on file." });
  });

  // A tool-only turn stores no reply text; an empty assistant message would be
  // a blank text block, which Anthropic rejects.
  it("adds no reply message when the stored reply is blank", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "  \n",
        steps: [step({ toolCalls: [{ toolCallId: "c1", toolName: "x", args: {} }], toolResults: [{ toolCallId: "c1", result: "ok" }] })],
      }),
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
  });

  it("sanitizes a namespaced plugin tool name (':' → '__') on both call and result", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [
          step({
            toolCalls: [{ toolCallId: "c1", toolName: "acme:updateContactCrm", args: {} }],
            toolResults: [{ toolCallId: "c1", result: "ok" }],
          }),
        ],
      }),
    ]);
    // Providers reject ':' in a toolUse name — a replayed namespaced call must be __.
    const call = (out[0].content as Array<{ type: string; toolName?: string }>).find((p) => p.type === "tool-call");
    const result = (out[1].content as Array<{ toolName?: string }>)[0];
    expect(call?.toolName).toBe("acme__updateContactCrm");
    expect(result.toolName).toBe("acme__updateContactCrm");
  });

  // A tool that moved into a plugin keeps its old flat name in turns stored
  // before the move. Replayed as is, the model reads a name it is no longer
  // given and may call it; it gets the name the tool has now.
  it("replays a tool that moved into a plugin under its current name", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [
          step({
            toolCalls: [{ toolCallId: "c1", toolName: "hubspotContact", args: {} }],
            toolResults: [{ toolCallId: "c1", result: "ok" }],
          }),
        ],
      }),
    ]);
    const call = (out[0].content as Array<{ type: string; toolName?: string }>).find((p) => p.type === "tool-call");
    const result = (out[1].content as Array<{ toolName?: string }>)[0];
    expect(call?.toolName).toBe("hubspot__contact");
    expect(result.toolName).toBe("hubspot__contact");
  });

  it("synthesizes a result when a call has none, so call/result pairing holds", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [step({ toolCalls: [{ toolCallId: "c1", toolName: "x", args: {} }], toolResults: [] })],
      }),
    ]);
    expect(parts(out[0])).toHaveLength(1); // only the tool-call (empty text omitted)
    expect(parts(out[1])[0].output).toEqual({ type: "text", value: "(no result recorded)" });
  });

  it("truncates large results", () => {
    const big = "x".repeat(MAX_REPLAYED_RESULT_CHARS + 500);
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [step({ toolCalls: [{ toolCallId: "c1", toolName: "x", args: {} }], toolResults: [{ toolCallId: "c1", result: big }] })],
      }),
    ]);
    const value = (parts(out[1])[0].output as { value: string }).value;
    expect(value.length).toBeLessThan(big.length);
    expect(value).toContain("truncated");
  });

  it("flattens a multi-step turn into one assistant + one tool message", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [
          step({ toolCalls: [{ toolCallId: "a", toolName: "t1", args: {} }], toolResults: [{ toolCallId: "a", result: "r1" }] }),
          step({ index: 1, stepType: "continue", toolCalls: [{ toolCallId: "b", toolName: "t2", args: {} }], toolResults: [{ toolCallId: "b", result: "r2" }] }),
        ],
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(parts(out[0])).toHaveLength(2); // 2 tool-calls, no text part (empty content)
    expect(parts(out[1])).toHaveLength(2); // 2 tool-results
    expect(parts(out[1]).map((p) => p.toolCallId)).toEqual(["a", "b"]);
  });

  it("sanitizes a persisted hook id (legacy 'hook:<uuid>') for the wire, keeping call/result pairing", () => {
    // Bedrock rejects tool_use.id outside ^[a-zA-Z0-9_-]+$ — the ':' minted by
    // older hook turns must be neutralized on replay, identically on both sides.
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [step({
          toolCalls: [{ toolCallId: "hook:550e8400-e29b", toolName: "lookupContact", args: {} }],
          toolResults: [{ toolCallId: "hook:550e8400-e29b", result: "ok" }],
        })],
      }),
    ]);
    const callId = (parts(out[0])[0] as { toolCallId: string }).toolCallId;
    const resultId = (parts(out[1])[0] as { toolCallId: string }).toolCallId;
    expect(callId).toBe("hook_550e8400-e29b");
    expect(callId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(resultId).toBe(callId); // pairing preserved
    expect((parts(out[1])[0].output as { value: string }).value).toBe("ok"); // result still resolved via raw id
  });

  it("keeps a plain string result as-is (no JSON quoting)", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [step({ toolCalls: [{ toolCallId: "c1", toolName: "x", args: {} }], toolResults: [{ toolCallId: "c1", result: "plain text" }] })],
      }),
    ]);
    expect((parts(out[1])[0].output as { value: string }).value).toBe("plain text");
  });
});
