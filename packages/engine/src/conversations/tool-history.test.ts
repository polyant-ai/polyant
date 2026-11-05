// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  buildExactHistory,
  buildHistoryWithToolResults,
  MAX_REPLAYED_RESULT_CHARS,
  requestPrefixKey,
  toExactUserMessage,
  withoutStaleReasoning,
} from "./tool-history.js";
import type { MessageRow } from "./store.js";
import type { StepDetail } from "./schema.js";

function row(partial: Partial<MessageRow> & { role: string; content: string }): MessageRow {
  return { steps: null, createdAt: null, ...partial };
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
            toolCalls: [{ toolCallId: "c1", toolName: "lookupContact", args: { action: "search" } }],
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

// ---------------------------------------------------------------------------
// Exact replay: a turn comes back as the model was sent it, so the next
// request's prefix is the one the provider already cached.
// ---------------------------------------------------------------------------

/** A knowledge-base section longer than the compact truncation limit. */
const SECTION = `## Tariffe\n${"Sky TV + Sky Sport, 29,90 euro al mese. ".repeat(80)}`;

const CONTEXT_TAIL = "<context>\n<current_datetime>\nThe current date and time is Tuesday 3 November 2026 at 10:15 (Europe/Rome).\n</current_datetime>\n</context>";

/** The user turn as `buildUserContent` sent it: the words, then the volatile tail. */
const sentUser = (text: string): ModelMessage => ({
  role: "user",
  content: [
    { type: "text", text },
    { type: "text", text: CONTEXT_TAIL },
  ],
});

/** A two-step turn as the AI SDK fed it back between steps (`responseMessages`). */
function sentTwoStepTurn(): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "sig-1" } } },
        { type: "tool-call", toolCallId: "toolu_01", toolName: "kb_search", input: { query: "tariffe", limit: 3 } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_01",
          toolName: "kb_search",
          output: { type: "json", value: { hits: [{ id: "doc-7", title: "Tariffe", section: SECTION }] } },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "sig-2" } } },
        { type: "tool-call", toolCallId: "toolu_02", toolName: "mcp__crm__get_contract", input: { customerId: "C-42" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_02",
          toolName: "mcp__crm__get_contract",
          output: { type: "content", value: [{ type: "text", text: "Contratto attivo dal 2024." }] },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Il tuo abbonamento costa 29,90 euro al mese." }] },
  ] as ModelMessage[];
}

/** The rows that turn left in the conversation table. */
function exactTurnRows(prefixKey = "key-A"): MessageRow[] {
  return [
    row({ role: "user", content: "Quanto pago?", exactReplay: { messages: [sentUser("Quanto pago?")] } }),
    row({
      role: "assistant",
      content: "Il tuo abbonamento costa 29,90 euro al mese.",
      steps: [
        step({
          toolCalls: [{ toolCallId: "toolu_01", toolName: "kb_search", args: { query: "tariffe", limit: 3 } }],
          toolResults: [{ toolCallId: "toolu_01", result: { hits: [] } }],
        }),
      ],
      exactReplay: { messages: sentTwoStepTurn(), prefixKey },
    }),
  ];
}

describe("buildExactHistory", () => {
  it("replays a multi-step turn step by step, in the order it was sent", () => {
    const out = buildExactHistory(exactTurnRows(), { keepReasoning: true });

    expect(out).toEqual([sentUser("Quanto pago?"), ...sentTwoStepTurn()]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  });

  it("serializes byte for byte like the request the turn was sent in", () => {
    const sent = JSON.stringify([sentUser("Quanto pago?"), ...sentTwoStepTurn()]);
    expect(JSON.stringify(buildExactHistory(exactTurnRows(), { keepReasoning: true }))).toBe(sent);
  });

  it("keeps tool results whole and in the output shape the tool produced", () => {
    const out = buildExactHistory(exactTurnRows(), { keepReasoning: true });

    const kb = parts(out[2])[0].output as { type: string; value: { hits: { section: string }[] } };
    expect(kb.type).toBe("json");
    expect(kb.value.hits[0].section).toBe(SECTION);
    expect(SECTION.length).toBeGreaterThan(MAX_REPLAYED_RESULT_CHARS);
    expect((parts(out[4])[0].output as { type: string }).type).toBe("content");
  });

  it("replays the user turn with the volatile context tail it was sent with", () => {
    const [user] = buildExactHistory(exactTurnRows(), { keepReasoning: true });

    expect(parts(user).map((p) => p.text)).toEqual(["Quanto pago?", CONTEXT_TAIL]);
  });

  it("drops the reasoning parts when asked to, and nothing else", () => {
    const out = buildExactHistory(exactTurnRows(), { keepReasoning: false });

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(out.flatMap((m) => (Array.isArray(m.content) ? parts(m) : [])).some((p) => p.type === "reasoning")).toBe(false);
    expect(parts(out[1])).toEqual([
      { type: "tool-call", toolCallId: "toolu_01", toolName: "kb_search", input: { query: "tariffe", limit: 3 } },
    ]);
  });

  it("rebuilds compactly the rows persisted before the agent switched to exact replay", () => {
    const out = buildExactHistory(
      [
        row({ role: "user", content: "Ciao" }),
        row({
          role: "assistant",
          content: "Fatto.",
          steps: [step({ toolCalls: [{ toolCallId: "c1", toolName: "lookup", args: { q: 1 } }], toolResults: [{ toolCallId: "c1", result: "ok" }] })],
        }),
        ...exactTurnRows(),
      ],
      { keepReasoning: true },
    );

    expect(out.slice(0, 3)).toEqual([
      { role: "user", content: "Ciao" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Fatto." },
          { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: 1 } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookup", output: { type: "text", value: "ok" } }] },
    ]);
    expect(out.slice(3)).toEqual([sentUser("Quanto pago?"), ...sentTwoStepTurn()]);
  });

  it("rebuilds compactly a turn whose stored messages leave a tool call without its result", () => {
    const unpaired = sentTwoStepTurn().slice(0, 3); // ends on the second call, its result missing
    const out = buildExactHistory(
      [
        row({
          role: "assistant",
          content: "",
          steps: [step({ toolCalls: [{ toolCallId: "toolu_01", toolName: "kb_search", args: {} }], toolResults: [{ toolCallId: "toolu_01", result: "r" }] })],
          exactReplay: { messages: unpaired, prefixKey: "key-A" },
        }),
      ],
      { keepReasoning: true },
    );

    expect(out).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_01", toolName: "kb_search", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "toolu_01", toolName: "kb_search", output: { type: "text", value: "r" } }] },
    ]);
  });

  it("rebuilds compactly when the stored messages do not fit the row's role", () => {
    const out = buildExactHistory(
      [row({ role: "user", content: "Ciao", exactReplay: { messages: sentTwoStepTurn() } })],
      { keepReasoning: true },
    );
    expect(out).toEqual([{ role: "user", content: "Ciao" }]);
  });

  it("presents a tool that has since moved into a plugin under its current name, on both sides", () => {
    const out = buildExactHistory(
      [
        row({
          role: "assistant",
          content: "",
          exactReplay: {
            messages: [
              { role: "assistant", content: [{ type: "tool-call", toolCallId: "t:1", toolName: "hubspotContact", input: {} }] },
              { role: "tool", content: [{ type: "tool-result", toolCallId: "t:1", toolName: "hubspotContact", output: { type: "text", value: "ok" } }] },
            ],
          },
        }),
      ],
      { keepReasoning: true },
    );
    expect(parts(out[0])[0]).toMatchObject({ toolName: "hubspot__contact", toolCallId: "t_1" });
    expect(parts(out[1])[0]).toMatchObject({ toolName: "hubspot__contact", toolCallId: "t_1" });
  });
});

describe("withoutStaleReasoning", () => {
  it("keeps the reasoning of turns that ran under the request's prefix", () => {
    const history = buildExactHistory(exactTurnRows("key-A"), { keepReasoning: true });
    expect(withoutStaleReasoning(history, "key-A")).toBe(history);
  });

  it("drops the reasoning of turns that ran under another prefix", () => {
    const history = buildExactHistory(exactTurnRows("key-A"), { keepReasoning: true });

    const out = withoutStaleReasoning(history, "key-B");

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(out.flatMap((m) => (Array.isArray(m.content) ? parts(m) : [])).some((p) => p.type === "reasoning")).toBe(false);
    expect(out[5]).toBe(history[5]); // the final text had no reasoning to drop
  });

  it("drops only the stale turns when the prefix changed between them", () => {
    const older = exactTurnRows("key-A");
    const newer = exactTurnRows("key-B");
    const history = buildExactHistory([...older, ...newer], { keepReasoning: true });

    const out = withoutStaleReasoning(history, "key-B");

    const reasoningAt = out.map((m) => (Array.isArray(m.content) ? parts(m).some((p) => p.type === "reasoning") : false));
    expect(reasoningAt).toEqual([false, false, false, false, false, false, false, true, false, true, false, false]);
  });

  it("returns a history without exact turns untouched", () => {
    const history = buildHistoryWithToolResults([row({ role: "user", content: "hi" })]);
    expect(withoutStaleReasoning(history, "key-A")).toBe(history);
  });
});

describe("requestPrefixKey", () => {
  const tools = { kb_search: { description: "Search" }, get_contract: { description: "Contract" } };
  const base = { system: "You are Sky's assistant.", messages: [] as ModelMessage[], tools, provider: "anthropic", model: "claude-sonnet-5-5" };

  it("ignores the order the tools were built in", () => {
    const reordered = { get_contract: tools.get_contract, kb_search: tools.kb_search };
    expect(requestPrefixKey({ ...base, tools: reordered })).toBe(requestPrefixKey(base));
  });

  it("changes with the system prompt, an inline system message, a tool or the model", () => {
    const key = requestPrefixKey(base);
    expect(requestPrefixKey({ ...base, system: "You are Sky's agent." })).not.toBe(key);
    expect(requestPrefixKey({ ...base, messages: [{ role: "system", content: "Webhook context" }] })).not.toBe(key);
    expect(requestPrefixKey({ ...base, tools: { ...tools, kb_search: { description: "Search the KB" } } })).not.toBe(key);
    expect(requestPrefixKey({ ...base, model: "claude-opus-5-5" })).not.toBe(key);
  });

  it("ignores the conversation's user and assistant messages", () => {
    expect(requestPrefixKey({ ...base, messages: [{ role: "user", content: "Quanto pago?" }] })).toBe(requestPrefixKey(base));
  });
});

describe("toExactUserMessage", () => {
  it("keeps the words and the context tail, and replaces an image with the note a text-only model gets", () => {
    const sent: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "Ecco la bolletta" },
        { type: "image", image: "aGVsbG8=", mediaType: "image/jpeg" },
        { type: "text", text: CONTEXT_TAIL },
      ],
    };

    expect(toExactUserMessage(sent)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Ecco la bolletta" },
        { type: "text", text: "[attachment: image/jpeg]" },
        { type: "text", text: CONTEXT_TAIL },
      ],
    });
  });

  it("keeps a plain string user message as it is", () => {
    const sent: ModelMessage = { role: "user", content: "Ciao" };
    expect(toExactUserMessage(sent)).toBe(sent);
  });
});
