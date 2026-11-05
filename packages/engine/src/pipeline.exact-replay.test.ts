// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Exact history replay, end to end through the pipeline: an agent on "exact"
 * keeps each turn as the model received it and replays it that way, so the next
 * request starts with the prefix the provider already cached. An agent on the
 * default "compact" replay sends and stores exactly what it did before the
 * option existed, even when the rows carry exact data.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";

const { mockOpenConversationTurn, mockGetHistoryWindow, mockResolveConfig, mockAppendMessages } = vi.hoisted(() => ({
  mockOpenConversationTurn: vi.fn(),
  mockGetHistoryWindow: vi.fn(),
  mockResolveConfig: vi.fn(),
  mockAppendMessages: vi.fn(async (_conversationId: string, _rows: unknown[]) => undefined),
}));

vi.mock("./conversations/index.js", () => ({
  conversationStore: {
    openConversationTurn: mockOpenConversationTurn,
    getHistoryWindow: mockGetHistoryWindow,
    appendMessages: mockAppendMessages,
    clearContextPrompt: vi.fn(async () => undefined),
  },
}));
vi.mock("./conversations/state.buffer.js", () => ({
  ConversationStateBuffer: class {
    static load = vi.fn(async () => new this());
    seedChannel() {}
  },
}));
vi.mock("./instances/config-resolver.js", () => ({ resolveInstanceConfig: mockResolveConfig }));
vi.mock("./activity-stream/emit-helpers.js", () => ({ resolveInstanceMeta: vi.fn(async () => undefined) }));
vi.mock("./activity-stream/emitters/emit-inbound.js", () => ({ emitInbound: vi.fn() }));
vi.mock("./activity-stream/emitters/emit-conversation.js", () => ({ emitConversation: vi.fn() }));
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: vi.fn(async () => undefined) }));
vi.mock("./memory/index.js", () => ({ extractMemories: vi.fn(async () => undefined) }));
vi.mock("./analytics/trace.store.js", () => ({ traceStore: { record: vi.fn() } }));
vi.mock("./hooks/hooks.store.js", () => ({ getEnabledHooks: vi.fn(async () => []) }));
vi.mock("./hooks/hook-registry.js", () => ({ getHookRegistry: vi.fn(() => new Map()) }));
vi.mock("./hooks/hook-runner.js", () => ({
  runHooks: vi.fn(async () => []),
  firstHalt: vi.fn(),
  firstReplaceResponse: vi.fn(),
  firstRegenerate: vi.fn(),
  collectInjectContext: vi.fn(() => []),
  hookProvenance: vi.fn(() => undefined),
}));

import { preparePipeline, runPipelinePost, type PipelineContext } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import type { MessageRow } from "./conversations/store.js";
import { HISTORY_HARD_CAP } from "./conversations/history-window.js";

const msg = {
  instanceId: asInstanceSlug("sky"),
  channelType: "web",
  channelId: "c1",
  userName: "u",
  text: "E il decoder?",
  metadata: {},
} as never;

const TAIL = "<context>\n<current_datetime>\nThe current date and time is Tuesday 3 November 2026 at 10:15.\n</current_datetime>\n</context>";
const LONG_RESULT = "Sezione 4.2 — Decoder Sky Q. ".repeat(120);

const sentUser: ModelMessage = {
  role: "user",
  content: [
    { type: "text", text: "Quanto pago?" },
    { type: "text", text: TAIL },
  ],
};
const sentResponse = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "sig-1" } } },
      { type: "tool-call", toolCallId: "toolu_01", toolName: "kb_search", input: { query: "decoder" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "toolu_01", toolName: "kb_search", output: { type: "text", value: LONG_RESULT } }],
  },
  { role: "assistant", content: [{ type: "text", text: "Paghi 29,90 euro." }] },
] as ModelMessage[];

function storedTurn(): MessageRow[] {
  return [
    { role: "user", content: "Quanto pago?", steps: null, exactReplay: { messages: [sentUser] }, createdAt: null },
    {
      role: "assistant",
      content: "Paghi 29,90 euro.",
      steps: [
        {
          index: 0,
          stepType: "initial",
          text: "",
          toolCalls: [{ toolCallId: "toolu_01", toolName: "kb_search", args: { query: "decoder" } }],
          toolResults: [{ toolCallId: "toolu_01", result: LONG_RESULT }],
          finishReason: "tool-calls",
          durationMs: 1,
        },
      ],
      exactReplay: { messages: sentResponse, prefixKey: "key-A" },
      createdAt: null,
    },
  ];
}

const config = (toolHistoryReplay: "compact" | "exact") => ({
  toolResultsInHistoryEnabled: true,
  toolHistoryReplay,
  langsmith: { enabled: false },
});

/** The conversation row as a turn opens it; `summaryThrough` set means earlier messages were folded into a summary. */
const openedTurn = (summaryThrough: Date | null = null) => ({
  created: false,
  contextPrompt: null,
  summary: summaryThrough ? "Earlier: the user asked about prices." : null,
  summaryThrough,
});

describe("preparePipeline — the history an agent replays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenConversationTurn.mockResolvedValue(openedTurn());
  });

  it("replays an exact agent's earlier turn as it was sent", async () => {
    mockResolveConfig.mockResolvedValue(config("exact"));
    mockGetHistoryWindow.mockResolvedValue(storedTurn());

    const ctx = await preparePipeline(msg);

    expect(ctx.history).toEqual([sentUser, ...sentResponse]);
    expect(mockGetHistoryWindow).toHaveBeenCalledWith(
      "sky:web:c1",
      expect.objectContaining({ withSteps: true, withExactReplay: true }),
    );
  });

  it("keeps the compact rebuild for a compact agent, whatever the rows carry", async () => {
    mockResolveConfig.mockResolvedValue(config("compact"));
    mockGetHistoryWindow.mockResolvedValue(storedTurn());

    const ctx = await preparePipeline(msg);

    expect(mockGetHistoryWindow).toHaveBeenCalledWith(
      "sky:web:c1",
      expect.objectContaining({ withSteps: true, withExactReplay: false }),
    );
    expect(ctx.history).toEqual([
      { role: "user", content: "Quanto pago?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Paghi 29,90 euro." },
          { type: "tool-call", toolCallId: "toolu_01", toolName: "kb_search", input: { query: "decoder" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_01",
            toolName: "kb_search",
            output: { type: "text", value: `${LONG_RESULT.slice(0, 2000)}… (truncated, ${LONG_RESULT.length} chars total)` },
          },
        ],
      },
    ]);
  });

  it("stops replaying reasoning once the window no longer starts at the conversation's start", async () => {
    mockResolveConfig.mockResolvedValue(config("exact"));
    mockOpenConversationTurn.mockResolvedValue(openedTurn(new Date("2026-11-03T09:00:00Z")));
    mockGetHistoryWindow.mockResolvedValue(storedTurn());

    const ctx = await preparePipeline(msg);

    expect(ctx.history).toEqual([
      sentUser,
      { role: "assistant", content: [(sentResponse[0].content as unknown[])[1]] },
      ...sentResponse.slice(1),
    ]);
  });

  it("stops replaying reasoning when the history read was cut at its cap", async () => {
    mockResolveConfig.mockResolvedValue(config("exact"));
    const filler: MessageRow[] = Array.from({ length: HISTORY_HARD_CAP - 2 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
      steps: null,
      createdAt: null,
    }));
    mockGetHistoryWindow.mockResolvedValue([...filler, ...storedTurn()]);

    const ctx = await preparePipeline(msg);

    const replayed = ctx.history!.slice(-4);
    expect(replayed[0]).toEqual(sentUser);
    expect(replayed[1]).toEqual({ role: "assistant", content: [(sentResponse[0].content as unknown[])[1]] });
  });
});

describe("runPipelinePost — what a turn keeps for exact replay", () => {
  beforeEach(() => vi.clearAllMocks());

  const exactTurn = { user: sentUser, response: sentResponse, prefixKey: "key-A" };

  function ctx(toolHistoryReplay: "compact" | "exact"): PipelineContext {
    return {
      pipelineStart: 0,
      instanceId: asInstanceSlug("sky"),
      conversationId: "sky:web:c1",
      conversationSummary: undefined,
      contextPrompt: undefined,
      channelIdentity: undefined,
      stateBuffer: undefined,
      history: undefined,
      isFirstTurn: false,
      instanceConfig: config(toolHistoryReplay) as unknown as PipelineContext["instanceConfig"],
      langsmith: undefined,
      userAttachments: undefined,
      isAutoTaskTurn: false,
      inboundMetadata: undefined,
    };
  }

  const post = (c: PipelineContext, provenance?: { source: "hook"; hookName: string }) =>
    runPipelinePost({
      ctx: c,
      contextPrepMs: 1,
      messageText: "Quanto pago?",
      channel: "web",
      resultText: "Paghi 29,90 euro.",
      usage: { promptTokens: 1, completionTokens: 1 },
      durationMs: 1,
      toolBuildingMs: 0,
      isStreaming: false,
      exactTurn,
      provenance,
    });

  type WrittenRow = { role: string; exactReplay?: unknown };
  const rowsWritten = () => mockAppendMessages.mock.calls.flatMap(([, rows]) => rows as WrittenRow[]);

  it("stores the user turn and the step-by-step response on an exact agent", async () => {
    await post(ctx("exact"));

    await vi.waitFor(() => expect(rowsWritten()).toHaveLength(2));
    const [userRow, assistantRow] = rowsWritten();
    expect(userRow.exactReplay).toEqual({ messages: [sentUser] });
    expect(assistantRow.exactReplay).toEqual({ messages: sentResponse, prefixKey: "key-A" });
  });

  it("stores nothing extra on a compact agent", async () => {
    await post(ctx("compact"));

    await vi.waitFor(() => expect(rowsWritten()).toHaveLength(2));
    expect(rowsWritten().map((r) => "exactReplay" in r)).toEqual([false, false]);
  });

  it("does not store the model's response when a hook wrote the reply", async () => {
    await post(ctx("exact"), { source: "hook", hookName: "rewrite" });

    await vi.waitFor(() => expect(rowsWritten()).toHaveLength(2));
    const [userRow, assistantRow] = rowsWritten();
    expect(userRow.exactReplay).toEqual({ messages: [sentUser] });
    expect("exactReplay" in assistantRow).toBe(false);
  });
});
