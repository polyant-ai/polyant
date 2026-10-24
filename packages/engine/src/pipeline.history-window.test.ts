// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The history the model sees must stay append-only between window advances, or
 * the prompt cache re-writes it on every call and never reads it. A window that
 * keeps "the last 10 messages" changes its first message on every turn. And no
 * exchange may leave the window before the stored summary covers it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetRecentMessages, mockEnsure, mockSummaryState, mockConfig, storeReads } = vi.hoisted(() => ({
  /** The persisted rows, newest `limit` (fixture). */
  mockGetRecentMessages: vi.fn(),
  mockEnsure: vi.fn(),
  /** The stored summary, marker and user-message count (fixture). */
  mockSummaryState: vi.fn(),
  mockConfig: vi.fn(),
  /** Every history read preparePipeline makes, in order, with its arguments after the conversation id. */
  storeReads: [] as unknown[][],
}));

vi.mock("./conversations/index.js", () => {
  const read =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      storeReads.push([name, ...a.slice(1)]);
      return fn(...a);
    };
  return {
    conversationStore: {
      ensureConversation: mockEnsure,
      // The separate reads turns made before the snapshot, so a turn still making them shows in storeReads.
      getRecentMessages: read("getRecentMessages", mockGetRecentMessages),
      // One statement: the rows and, from the same snapshot, the summary state (none without rows).
      getHistorySnapshot: read("getHistorySnapshot", async (id: string, limit: number) => {
        const rows = await mockGetRecentMessages(id, limit);
        const state = rows.length > 0 ? await mockSummaryState(id) : undefined;
        return {
          rows,
          summary: state?.summary ?? null,
          summaryThrough: state?.summaryThrough ?? null,
          userMessageCount: state?.userMessageCount ?? null,
        };
      }),
      getContextPrompt: vi.fn(async () => null),
    },
  };
});
vi.mock("./conversations/state.buffer.js", () => ({
  ConversationStateBuffer: class {
    static load = vi.fn(async () => new this());
    seedChannel() {}
  },
}));
// The real model resolution (the gateway's fallback to the provider's standard tier); only the config is a fixture.
vi.mock("./instances/config-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./instances/config-resolver.js")>()),
  resolveInstanceConfig: mockConfig,
}));

/** The resolved agent config the pipeline reads; provider and model unset mean the deployment defaults. */
function agent(over: { cacheEnabled?: boolean; provider?: string; model?: string; replay?: boolean } = {}) {
  mockConfig.mockResolvedValue({
    toolResultsInHistoryEnabled: over.replay ?? false,
    langsmith: { enabled: false },
    cacheConfig: { enabled: over.cacheEnabled ?? true, ttl: "1h" },
    provider: over.provider,
    model: over.model,
  });
}
vi.mock("./activity-stream/emit-helpers.js", () => ({ resolveInstanceMeta: vi.fn(async () => undefined) }));
vi.mock("./activity-stream/emitters/emit-inbound.js", () => ({ emitInbound: vi.fn() }));
vi.mock("./activity-stream/emitters/emit-conversation.js", () => ({ emitConversation: vi.fn() }));

import { preparePipeline } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";

const msg = {
  instanceId: asInstanceSlug("shop"),
  channelType: "web",
  channelId: "c1",
  userName: "u",
  text: "next",
  metadata: {},
} as never;

interface Persisted {
  /** Exchanges the stored summary covers; defaults to the block start (every refresh landed). */
  through?: number | null;
  /** The count `ensureConversation` saw, before another turn's rows landed; defaults to `exchanges`. */
  ensureCount?: number;
  content?: Record<string, string>;
}

/** A conversation of `exchanges` persisted user/assistant pairs. */
function persist(exchanges: number, opts: Persisted = {}) {
  const rows: { role: string; content: string }[] = [];
  for (let i = 0; i < exchanges; i++) {
    rows.push({ role: "user", content: opts.content?.[`u${i}`] ?? `u${i}` });
    rows.push({ role: "assistant", content: opts.content?.[`a${i}`] ?? `a${i}` });
  }
  const blockStart = 5 * Math.floor(Math.max(0, exchanges - 5) / 5);
  const through = opts.through === undefined ? blockStart : opts.through;
  mockEnsure.mockResolvedValue({ created: false, userMessageCount: opts.ensureCount ?? exchanges });
  mockGetRecentMessages.mockImplementation(async (_id: string, limit: number) => rows.slice(-limit));
  mockSummaryState.mockResolvedValue({
    summary: through ? "summary" : null,
    summaryThrough: through,
    userMessageCount: exchanges,
  });
}

const texts = (m: { content: unknown }[] | undefined) => m?.map((x) => String(x.content));

/**
 * Turn by turn over a growing conversation, writing back the marker each refresh
 * stores (as the post-response summary write does). Returns the first history
 * message and the history length the model saw on each turn.
 */
async function converse(fromExchanges: number, toExchanges: number) {
  let through: number | null = null;
  const firsts: string[] = [];
  const lengths: (number | undefined)[] = [];
  for (let exchanges = fromExchanges; exchanges < toExchanges; exchanges++) {
    persist(exchanges, { through });
    const ctx = await preparePipeline(msg);
    firsts.push(String(ctx.history?.[0]?.content));
    lengths.push(ctx.history?.length);
    if (ctx.summaryCover) through = ctx.summaryCover.through;
  }
  return { firsts, lengths };
}

describe("preparePipeline — window without a prompt cache", () => {
  beforeEach(() => vi.clearAllMocks());

  it("slides one exchange per turn when the agent turns the prompt cache off", async () => {
    agent({ cacheEnabled: false });
    const { firsts, lengths } = await converse(5, 12);
    expect(firsts).toEqual(["u0", "u1", "u2", "u3", "u4", "u5", "u6"]);
    expect(lengths).toEqual([10, 10, 10, 10, 10, 10, 10]);
  });

  it("slides one exchange per turn on a model the catalog marks as uncached", async () => {
    agent({ provider: "bedrock", model: "qwen.qwen3-32b-v1:0" });
    const { firsts } = await converse(5, 12);
    expect(firsts).toEqual(["u0", "u1", "u2", "u3", "u4", "u5", "u6"]);
  });

  it("never drops an exchange the summary does not cover when the cache setting changes mid-conversation", async () => {
    let through: number | null = null;
    const lengths: (number | undefined)[] = [];
    for (let exchanges = 5; exchanges < 22; exchanges++) {
      agent({ cacheEnabled: exchanges < 11 || exchanges >= 16 });
      persist(exchanges, { through });
      const ctx = await preparePipeline(msg);
      const first = Number(String(ctx.history?.[0]?.content).slice(1));
      expect(first).toBe(through ?? 0);
      lengths.push(ctx.history?.length);
      if (ctx.summaryCover) through = ctx.summaryCover.through;
    }
    expect(Math.max(...lengths.map((n) => n ?? 0))).toBeLessThanOrEqual(18);
  });

  it("keeps blocks on a model with a prompt cache", async () => {
    agent({ provider: "anthropic", model: "claude-sonnet-5-5" });
    const { firsts, lengths } = await converse(5, 12);
    expect(firsts).toEqual(["u0", "u0", "u0", "u0", "u0", "u5", "u5"]);
    expect(lengths).toEqual([10, 12, 14, 16, 18, 10, 12]);
  });

  it("slides one exchange per turn when the model is unset and the provider's standard model is uncached", async () => {
    // The gateway calls nebius's standard tier, which the catalog prices without a cache discount.
    agent({ provider: "nebius" });
    const { firsts } = await converse(5, 12);
    expect(firsts).toEqual(["u0", "u1", "u2", "u3", "u4", "u5", "u6"]);
  });

  it("keeps blocks when the model is unset and the provider's standard model caches", async () => {
    agent({ provider: "anthropic" });
    const { firsts } = await converse(5, 12);
    expect(firsts).toEqual(["u0", "u0", "u0", "u0", "u0", "u5", "u5"]);
  });

  it("treats an empty provider or model as unset: the provider's standard model, here one with a cache", async () => {
    // An empty model id is not in the catalog, and bedrock's fallback for it is "no cache"; its standard model caches.
    for (const over of [{ provider: "bedrock", model: "" }, { provider: "", model: "" }]) {
      agent(over);
      const { firsts } = await converse(5, 12);
      expect({ over, firsts }).toEqual({ over, firsts: ["u0", "u0", "u0", "u0", "u0", "u5", "u5"] });
    }
  });

  it("slides one exchange per turn when the provider cannot be resolved", async () => {
    agent({ provider: "no-such-provider" });
    const { firsts } = await converse(5, 12);
    expect(firsts).toEqual(["u0", "u1", "u2", "u3", "u4", "u5", "u6"]);
  });
});

describe("preparePipeline — block history window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agent();
  });

  it("keeps the same first history message for five turns, then advances by five exchanges", async () => {
    const firsts: string[] = [];
    for (let exchanges = 10; exchanges < 20; exchanges++) {
      persist(exchanges);
      const ctx = await preparePipeline(msg);
      firsts.push(String(ctx.history?.[0]?.content));
      expect(ctx.hasOverflow).toBe(true);
      expect(ctx.conversationSummary).toBe("summary");
    }
    expect(firsts).toEqual(["u5", "u5", "u5", "u5", "u5", "u10", "u10", "u10", "u10", "u10"]);
  });

  it("folds the dropped exchanges into the summary only on the turn before an advance", async () => {
    const dropped: (string[] | undefined)[] = [];
    const covers: unknown[] = [];
    for (let exchanges = 10; exchanges < 15; exchanges++) {
      persist(exchanges);
      const ctx = await preparePipeline(msg);
      dropped.push(texts(ctx.droppedMessages));
      covers.push(ctx.summaryCover);
    }
    expect(dropped).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      ["u5", "a5", "u6", "a6", "u7", "a7", "u8", "a8", "u9", "a9"],
    ]);
    expect(covers).toEqual([undefined, undefined, undefined, undefined, { expected: 5, through: 10 }]);
  });

  it("keeps a block the summary does not cover in the window and folds it again (failed or late refresh)", async () => {
    // The refresh on turn 14 failed, or had not landed yet: the marker is still 5.
    persist(15, { through: 5 });
    const ctx = await preparePipeline(msg);
    expect(ctx.history?.[0]?.content).toBe("u5");
    expect(texts(ctx.droppedMessages)).toEqual(["u5", "a5", "u6", "a6", "u7", "a7", "u8", "a8", "u9", "a9"]);
    expect(ctx.summaryCover).toEqual({ expected: 5, through: 10 });
  });

  it("reads the rows, the summary and the count in one statement, with no summary read after it", async () => {
    persist(14);
    storeReads.length = 0;
    const ctx = await preparePipeline(msg);
    expect(storeReads).toEqual([["getHistorySnapshot", 40]]);
    expect(ctx.conversationSummary).toBe("summary");
    expect(ctx.summaryCover).toEqual({ expected: 5, through: 10 });
  });

  it("still refreshes when another turn's rows land between ensureConversation and the read", async () => {
    // The upsert saw 13 exchanges; the rows and the count read with them already hold 14.
    persist(14, { ensureCount: 13 });
    const ctx = await preparePipeline(msg);
    expect(texts(ctx.droppedMessages)).toEqual(["u5", "a5", "u6", "a6", "u7", "a7", "u8", "a8", "u9", "a9"]);
    expect(ctx.summaryCover).toEqual({ expected: 5, through: 10 });
  });

  it("reads the replay rows in the same statement, asking for the replay columns", async () => {
    agent({ replay: true });
    persist(14);
    storeReads.length = 0;
    const ctx = await preparePipeline(msg);
    expect(storeReads).toEqual([["getHistorySnapshot", 40, { steps: true }]]);
    expect(ctx.history?.[0]?.content).toBe("u5");
    expect(ctx.summaryCover).toEqual({ expected: 5, through: 10 });
  });

  it("passes a short conversation whole, without a summary", async () => {
    persist(9);
    const ctx = await preparePipeline(msg);
    expect(ctx.hasOverflow).toBe(false);
    expect(ctx.history).toHaveLength(18);
    expect(ctx.conversationSummary).toBeUndefined();
  });

  it("moves the start past long pasted messages once, folding down to half the budget", async () => {
    const big = "x".repeat(6_000);
    const content = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`u${i}`, big]));
    // 8 exchanges of 6k: over the 40k budget, the window drops u0 and u1 now and
    // the summary takes u0..u4, so the remaining 18k leave room to grow.
    persist(8, { through: null, content });
    const first = await preparePipeline(msg);
    expect(first.history?.[0]?.content).toBe(big);
    expect(first.history).toHaveLength(12);
    expect(first.droppedMessages).toHaveLength(10);
    expect(first.summaryCover).toEqual({ expected: null, through: 5 });
    // Once that refresh landed, the next turns start at u5 and only append.
    const starts: number[] = [];
    for (const exchanges of [9, 10, 11]) {
      persist(exchanges, { through: 5, content });
      const ctx = await preparePipeline(msg);
      starts.push(ctx.history?.length ?? 0);
      expect(ctx.droppedMessages).toBeUndefined();
    }
    expect(starts).toEqual([8, 10, 12]);
  });

  /** `exchanges` short exchanges whose answers each replay one tool call; the rows persisted for the snapshot. */
  function persistToolTurns(exchanges: number, through: number | null, stepsOf: (i: number) => unknown = (i) => [toolStep(i)]) {
    const rows: { role: string; content: string; steps?: unknown }[] = [];
    for (let i = 0; i < exchanges; i++) {
      rows.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}`, steps: stepsOf(i) });
    }
    mockEnsure.mockResolvedValue({ created: false, userMessageCount: exchanges });
    mockGetRecentMessages.mockImplementation(async (_id: string, limit: number) => rows.slice(-limit));
    mockSummaryState.mockResolvedValue({ summary: through ? "summary" : null, summaryThrough: through, userMessageCount: exchanges });
  }
  const toolStep = (i: number) => ({
    index: 0,
    stepType: "initial",
    text: "",
    finishReason: "tool-calls",
    toolCalls: [{ toolCallId: `c${i}`, toolName: "lookup", args: {} }],
    toolResults: [{ toolCallId: `c${i}`, result: `r${i}` }],
  });

  it("slides a tool-replay agent's window one exchange per turn, with the prompt cache on", async () => {
    // Blocks would carry up to four more exchanges of tool calls and results on every call.
    agent({ replay: true, cacheEnabled: true, provider: "anthropic", model: "claude-sonnet-5-5" });
    const firsts: string[] = [];
    const covers: (number | undefined)[] = [];
    let through = 1;
    for (const exchanges of [6, 7, 8]) {
      persistToolTurns(exchanges, through);
      const ctx = await preparePipeline(msg);
      firsts.push(String(ctx.history?.[0]?.content));
      covers.push(ctx.summaryCover?.through);
      through = ctx.summaryCover?.through ?? through;
    }
    expect(firsts).toEqual(["u1", "u2", "u3"]);
    expect(covers).toEqual([2, 3, 4]);
    // The same conversation without replay keeps its block: no refresh before exchange 10.
    agent({ replay: false, cacheEnabled: true, provider: "anthropic", model: "claude-sonnet-5-5" });
    persistToolTurns(8, 0);
    const blocks = await preparePipeline(msg);
    expect(blocks.history?.[0]?.content).toBe("u0");
    expect(blocks.summaryCover).toBeUndefined();
  });

  it("rebuilds the tool calls and results of the window rows only, and the text of an answer without steps", async () => {
    agent({ replay: true });
    // a4's steps read as null: no tool calls, or a cell the snapshot could not decode (store.ts).
    persistToolTurns(7, 2, (i) => (i === 4 ? null : [toolStep(i)]));
    const ctx = await preparePipeline(msg);
    expect(ctx.history?.[0]).toEqual({ role: "user", content: "u2" });
    const calls = ctx.history?.filter((m) => m.role === "tool").map((m) => (m.content as { toolCallId: string }[])[0].toolCallId);
    expect(calls).toEqual(["c2", "c3", "c5", "c6"]);
    expect(ctx.history).toContainEqual({ role: "assistant", content: "a4" });
    expect(texts(ctx.droppedMessages)).toEqual(["u2", "a2"]);
  });
});

describe("preparePipeline — history read edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agent();
  });

  const autoTask = { ...(msg as object), text: "### Task: title" } as never;
  const clientHistory = [{ role: "user", content: "from the client" }];
  const withClientHistory = { ...(msg as object), metadata: { conversationHistory: clientHistory } } as never;

  it("falls back to the client-side history when the history read fails or returns no rows", async () => {
    for (const read of [() => Promise.reject(new Error("db down")), async () => []]) {
      persist(20, { through: 15 });
      mockGetRecentMessages.mockImplementation(read);
      const ctx = await preparePipeline(withClientHistory);
      expect(ctx.history).toEqual(clientHistory);
      expect(ctx.hasOverflow).toBe(false);
      expect(ctx.conversationSummary).toBeUndefined();
      expect(ctx.droppedMessages).toBeUndefined();
      expect(ctx.summaryCover).toBeUndefined();
    }
  });

  it("shows a stored summary whose marker is 0 and refreshes on top of it", async () => {
    // Room compaction moved the marker back to 0; the summary text is still stored.
    persist(14, { through: 0 });
    mockSummaryState.mockResolvedValue({ summary: "room summary", summaryThrough: 0, userMessageCount: 14 });
    const ctx = await preparePipeline(msg);
    expect(ctx.history?.[0]?.content).toBe("u0");
    expect(ctx.conversationSummary).toBe("room summary");
    expect(ctx.summaryCover).toEqual({ expected: 0, through: 10 });
  });

  it("keeps a summary whose marker is 0 off an auto-task turn whose window holds every row", async () => {
    // As past the 15-row threshold before: an auto-task turn sees the summary only past the window.
    persist(8, { through: 0 });
    mockSummaryState.mockResolvedValue({ summary: "room summary", summaryThrough: 0, userMessageCount: 8 });
    expect((await preparePipeline(msg)).conversationSummary).toBe("room summary");
    const auto = await preparePipeline(autoTask);
    expect(auto.hasOverflow).toBe(false);
    expect(auto.conversationSummary).toBeUndefined();
  });

  it("shows the summary when the window starts after exchange 0, on auto-task turns too", async () => {
    persist(20, { through: 15 });
    expect((await preparePipeline(msg)).conversationSummary).toBe("summary");
    expect((await preparePipeline(autoTask)).conversationSummary).toBe("summary");
  });

  it("shows the summary when the rows read do not reach exchange 0, whatever the marker", async () => {
    // 30 exchanges: the 40 rows read start at u10. Marker 0 and a missing marker trust no exchange.
    for (const through of [0, null]) {
      persist(30, { through });
      mockSummaryState.mockResolvedValue({ summary: "old summary", summaryThrough: through, userMessageCount: 30 });
      const auto = await preparePipeline(autoTask);
      expect({ through, first: auto.history?.[0]?.content }).toEqual({ through, first: "u10" });
      expect(auto.hasOverflow).toBe(true);
      expect(auto.conversationSummary).toBe("old summary");
    }
  });

  it("opens the window on a user row when the rows read start inside an exchange the summary does not cover, and folds the rows before it", async () => {
    // 23 exchanges; the rows read start at a3, whose user row was not read.
    const rows = [{ role: "assistant", content: "a3" }];
    for (let i = 4; i < 23; i++) rows.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
    for (const through of [0, null]) {
      mockGetRecentMessages.mockImplementation(async () => rows);
      mockSummaryState.mockResolvedValue({ summary: "old summary", summaryThrough: through, userMessageCount: 23 });
      const ctx = await preparePipeline(msg);
      expect({ through, first: ctx.history?.[0]?.content }).toEqual({ through, first: "u4" });
      // a3 belongs to an exchange the marker does not reach: summarized, not lost.
      expect({ through, folded: texts(ctx.droppedMessages)?.slice(0, 2) }).toEqual({ through, folded: ["a3", "u4"] });
      expect(ctx.conversationSummary).toBe("old summary");
    }
  });

  it("leaves the rows before the first user row read out of a refresh that does not cover their exchange", async () => {
    // 30 exchanges; the rows read are 34 outbound answers of exchange 26, then u27..a29.
    // The refresh reaches exchange 25 or 26 only: folding them now would fold them again next turn.
    const rows = Array.from({ length: 34 }, (_, k) => ({ role: "assistant", content: `o${k}` }));
    for (let i = 27; i < 30; i++) rows.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
    mockGetRecentMessages.mockImplementation(async () => rows);
    mockSummaryState.mockResolvedValue({ summary: "old summary", summaryThrough: 0, userMessageCount: 30 });
    const ctx = await preparePipeline(msg);
    expect(ctx.history?.[0]?.content).toBe("u27");
    expect(ctx.droppedMessages).toBeUndefined();
    expect(ctx.summaryCover).toBeUndefined();
  });

  it("trusts a summary without a marker for no exchange: shown, window from the first row, refreshed from null", async () => {
    // An engine without the marker wrote this summary during a rollout: of unknown extent.
    persist(20, { through: null });
    mockSummaryState.mockResolvedValue({ summary: "old summary", summaryThrough: null, userMessageCount: 20 });
    const ctx = await preparePipeline(msg);
    expect(ctx.history?.[0]?.content).toBe("u0");
    expect(ctx.conversationSummary).toBe("old summary");
    expect(ctx.storedSummary).toBe("old summary");
    expect(texts(ctx.droppedMessages)?.[0]).toBe("u0");
    expect(ctx.summaryCover).toEqual({ expected: null, through: 15 });
    // The window holds every row: an auto-task turn gets no summary.
    const auto = await preparePipeline(autoTask);
    expect(auto.history?.[0]?.content).toBe("u0");
    expect(auto.conversationSummary).toBeUndefined();
  });

  it("trusts a marker past the count for no exchange: shown, window from the first row, refreshed from the stored value", async () => {
    // 20 exchanges, marker 25 (rows deleted since).
    persist(20, { through: 25 });
    const ctx = await preparePipeline(msg);
    expect(ctx.history?.[0]?.content).toBe("u0");
    expect(ctx.conversationSummary).toBe("summary");
    expect(ctx.summaryCover).toEqual({ expected: 25, through: 15 });
  });

  it("shows no summary when none is stored", async () => {
    persist(9, { through: null });
    const ctx = await preparePipeline(msg);
    expect(ctx.history?.[0]?.content).toBe("u0");
    expect(ctx.conversationSummary).toBeUndefined();
    expect(ctx.storedSummary).toBeUndefined();
    expect(ctx.summaryCover).toEqual({ expected: null, through: 5 });
  });

  it("warns, with ids only, when the marker is older than the rows read", async () => {
    const out: string[] = [];
    const capture = (chunk: unknown) => (out.push(String(chunk)), true);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    // 30 exchanges: the 40 rows read start at u10, the marker is still 5.
    persist(30, { through: 5 });
    await preparePipeline(msg);
    const line = out.find((l) => l.includes("older than the rows read"));
    expect(line).toContain("5 exchanges");
    expect(line).not.toMatch(/\bu\d+\b/);
    // With the marker inside the rows read there is nothing to warn about.
    out.length = 0;
    persist(30, { through: 20 });
    await preparePipeline(msg);
    expect(out.some((l) => l.includes("older than the rows read"))).toBe(false);
    vi.restoreAllMocks();
  });
});
