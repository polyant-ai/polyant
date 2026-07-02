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
        content: "Let me look that up.",
        steps: [
          step({
            toolCalls: [{ toolCallId: "c1", toolName: "hubspotContact", args: { action: "search" } }],
            toolResults: [{ toolCallId: "c1", result: { contactId: "123" } }],
          }),
        ],
      }),
    ]);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me look that up." },
        { type: "tool-call", toolCallId: "c1", toolName: "hubspotContact", input: { action: "search" } },
      ],
    });
    expect(out[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "hubspotContact",
          output: { type: "text", value: JSON.stringify({ contactId: "123" }) },
        },
      ],
    });
  });

  it("sanitizes a namespaced plugin tool name (':' → '__') on both call and result", () => {
    const out = buildHistoryWithToolResults([
      row({
        role: "assistant",
        content: "",
        steps: [
          step({
            toolCalls: [{ toolCallId: "c1", toolName: "innova:aggiornaBollettaCrm", args: {} }],
            toolResults: [{ toolCallId: "c1", result: "ok" }],
          }),
        ],
      }),
    ]);
    // Providers reject ':' in a toolUse name — a replayed namespaced call must be __.
    const call = (out[0].content as Array<{ type: string; toolName?: string }>).find((p) => p.type === "tool-call");
    const result = (out[1].content as Array<{ toolName?: string }>)[0];
    expect(call?.toolName).toBe("innova__aggiornaBollettaCrm");
    expect(result.toolName).toBe("innova__aggiornaBollettaCrm");
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
