// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sliding window against a real database.
 *
 * Past 15 messages a turn sees the stored summary plus the last 10 messages; the
 * older ones reach the model only through the summary. That holds only if every
 * message that leaves the window has already been handed to the summarizer by
 * the time a turn reads it. These tests follow consecutive turns through the
 * real conversation store, `preparePipeline` and the fire-and-forget
 * persistence, and check what the next turn can see.
 *
 * The summarizer is a stand-in that loses nothing: it returns every `fact-NN`
 * token it was given, so a token missing from what a turn sees was never handed
 * to it. Only the model calls (summary, title, memory) and the hook bodies are
 * replaced. Self-skips without a database; CI_REQUIRE_DB makes an absent one a
 * failure there.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

const summarizer = vi.hoisted(() => ({
  /** Resolves the first summary call when set; later calls run straight through. */
  holdFirst: undefined as undefined | Promise<void>,
  /** Calls (1-based) that fail, as a provider outage would. */
  failing: new Set<number>(),
  started: 0,
  /** The abort signal each call received, in call order. */
  signals: [] as (AbortSignal | undefined)[],
  /** Outputs in the order the calls finished. */
  outputs: [] as string[],
}));

vi.mock("./ai-gateway/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-gateway/index.js")>();
  return {
    ...actual,
    chat: async (req: { messages: ModelMessage[]; abortSignal?: AbortSignal }) => {
      const call = ++summarizer.started;
      summarizer.signals.push(req.abortSignal);
      const input = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      if (call === 1 && summarizer.holdFirst) await summarizer.holdFirst;
      if (summarizer.failing.has(call)) {
        summarizer.outputs.push("(failed)");
        throw new Error("provider unavailable");
      }
      const text = [...new Set(input.match(/fact-\d\d/g) ?? [])].sort().join(" ");
      summarizer.outputs.push(text);
      return { text, steps: [], usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
});
vi.mock("./hooks/hook-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/hook-runner.js")>();
  return { ...actual, runHooks: async () => [] };
});
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: async () => undefined }));
vi.mock("./memory/index.js", () => ({ extractMemories: async () => undefined }));

import { queryClient } from "./database/client.js";
import { resolveDatabaseAvailability } from "./database/test-db.js";
import { conversationStore } from "./conversations/index.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import { preparePipeline, runPipelinePost, type PipelineContext } from "./pipeline.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-summary-window";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

const fact = (n: number) => `fact-${String(n).padStart(2, "0")}`;
const facts = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => fact(from + i));

/** Remove every row this file created. */
async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug = ${AGENT}`;
}

/** A conversation whose messages are `fact-01` … `fact-<count>`, user and assistant in turn, an hour ago. */
async function seed(count: number): Promise<string> {
  const conversationId = `${MARKER}-${randomUUID()}`;
  await conversationStore.ensureConversation(conversationId, AGENT, { channel: "web" });
  const base = Date.now() - 3_600_000;
  await conversationStore.appendMessages(
    conversationId,
    facts(1, count).map((content, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
      createdAt: new Date(base + i * 1_000),
    })),
  );
  return conversationId;
}

/** What a turn starting now would read: the context `preparePipeline` builds. */
function read(conversationId: string, systemMessages?: string[]): Promise<PipelineContext> {
  const metadata = systemMessages ? { systemMessages: systemMessages.map((content) => ({ role: "system", content })) } : {};
  return preparePipeline(
    { channelType: "web", channelId: conversationId, instanceId: AGENT, text: "next", metadata },
    conversationId,
  );
}

/** Finish the turn read into `ctx`: the user wrote `user`, the agent answered `reply`. */
async function finish(ctx: PipelineContext, user: string, reply: string): Promise<void> {
  await runPipelinePost({
    ctx,
    contextPrepMs: 0,
    messageText: user,
    channel: "web",
    resultText: reply,
    usage: { promptTokens: 0, completionTokens: 0 },
    durationMs: 0,
    toolBuildingMs: 0,
    isStreaming: false,
  });
}

/** Give `condition` up to `ms` to become true, then go on either way. */
async function briefly(condition: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Everything a turn shows the model about earlier messages. */
function visible(ctx: PipelineContext): string {
  return [ctx.conversationSummary ?? "", ...(ctx.history ?? []).map((m) => String(m.content))].join(" ");
}

/** Rows stored for the conversation. */
async function messageCount(conversationId: string): Promise<number> {
  const [row] = await queryClient<{ n: number }[]>`
    SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${conversationId}`;
  return row!.n;
}

/** The summary column as stored. */
async function storedSummary(conversationId: string): Promise<string | null> {
  const [row] = await queryClient<{ summary: string | null }[]>`
    SELECT summary FROM conversations WHERE conversation_id = ${conversationId}`;
  return row?.summary ?? null;
}

/** Wait until the turn's rows are written and `calls` summaries have finished and been stored. */
async function settled(conversationId: string, rows: number, calls: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await messageCount(conversationId)).toBe(rows);
    expect(summarizer.outputs).toHaveLength(calls);
    const last = summarizer.outputs[calls - 1];
    if (last !== "(failed)") expect(await storedSummary(conversationId)).toBe(last);
  }, { timeout: 5_000 });
}

describe.skipIf(!DB_AVAILABLE)("sliding window summary (integration)", () => {
  beforeAll(async () => {
    await teardown();
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${AGENT}, 'summary window', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))`;
  });

  afterAll(teardown);

  beforeEach(() => {
    summarizer.holdFirst = undefined;
    summarizer.failing = new Set();
    summarizer.started = 0;
    summarizer.signals = [];
    summarizer.outputs = [];
    // The summary cache is per process; each test uses a fresh conversation id.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should_let_the_next_turn_see_every_earlier_message_in_the_window_or_the_summary", async () => {
    const conversationId = await seed(16);

    await finish(await read(conversationId), fact(17), fact(18));
    await settled(conversationId, 18, 1);

    const next = await read(conversationId);
    const seen = visible(next);
    expect(facts(1, 18).filter((f) => !seen.includes(f))).toEqual([]);
  });

  it("should_not_lose_a_summary_when_the_next_turn_starts_before_it_is_stored", async () => {
    const conversationId = await seed(16);
    let release!: () => void;
    summarizer.holdFirst = new Promise<void>((resolve) => (release = resolve));

    // Turn A finishes; its summary is still being written when turn B reads.
    await finish(await read(conversationId), fact(17), fact(18));
    await vi.waitFor(async () => expect(await messageCount(conversationId)).toBe(18), { timeout: 5_000 });
    const turnB = await read(conversationId);
    await finish(turnB, fact(19), fact(20));
    // A's summary stays out until B's update has started too (the two overlap),
    // or has had the time to start and is waiting for A.
    await vi.waitFor(async () => expect(await messageCount(conversationId)).toBe(20), { timeout: 5_000 });
    await briefly(() => summarizer.started >= 2, 500);
    release();
    await settled(conversationId, 20, 2);

    const next = await read(conversationId);
    const seen = visible(next);
    expect(facts(1, 20).filter((f) => !seen.includes(f))).toEqual([]);
  });

  it("should_start_the_next_summary_update_when_one_runs_past_its_deadline_and_never_store_the_late_one", async () => {
    // A 200 ms deadline instead of the real one. The first call ignores the
    // abort and answers only when released, as a stuck transport would.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(200));
    const stderr = vi.spyOn(process.stderr, "write");
    const deadlineWarnings = () => stderr.mock.calls.filter(([line]) => String(line).includes("passed its")).length;
    const conversationId = await seed(16);
    let release!: () => void;
    summarizer.holdFirst = new Promise<void>((resolve) => (release = resolve));

    await finish(await read(conversationId), fact(17), fact(18));
    await vi.waitFor(async () => expect(await messageCount(conversationId)).toBe(18), { timeout: 5_000 });
    await finish(await read(conversationId), fact(19), fact(20));

    // The second update does not wait for the stuck one past its deadline.
    await vi.waitFor(async () => {
      expect(summarizer.outputs).toHaveLength(1);
      expect(await storedSummary(conversationId)).toBe(summarizer.outputs[0]);
    }, { timeout: 5_000 });
    const stored = summarizer.outputs[0];
    expect(summarizer.signals[0]?.aborted).toBe(true);

    // The stuck call answers late: its summary must not replace the newer one.
    release();
    await vi.waitFor(() => expect(summarizer.outputs).toHaveLength(2), { timeout: 5_000 });
    // Long enough for the late write to land and for the second update's own deadline to pass.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(summarizer.outputs[1]).not.toBe(stored);
    expect(await storedSummary(conversationId)).toBe(stored);
    // Only the stuck update is reported; the one that finished in time is not.
    expect(deadlineWarnings()).toBe(1);
  });

  it("should_have_the_summary_ready_on_the_first_turn_that_overflows", async () => {
    // 14 messages: this turn shows them all, the next one (16) shows only 10.
    const conversationId = await seed(14);

    await finish(await read(conversationId), fact(15), fact(16));
    await settled(conversationId, 16, 1);

    const seen = visible(await read(conversationId));
    expect(facts(1, 16).filter((f) => !seen.includes(f))).toEqual([]);
  });

  it("should_recover_the_messages_of_a_summary_call_that_failed", async () => {
    // Steady state: the turn before left the six oldest messages in the summary.
    const conversationId = await seed(16);
    await conversationStore.updateSummary(conversationId, facts(1, 6).join(" "));
    summarizer.failing.add(1);

    await finish(await read(conversationId), fact(17), fact(18));
    await settled(conversationId, 18, 1);
    await finish(await read(conversationId), fact(19), fact(20));
    await settled(conversationId, 20, 2);

    const seen = visible(await read(conversationId));
    expect(facts(1, 20).filter((f) => !seen.includes(f))).toEqual([]);
  });

  it("should_count_the_system_messages_a_turn_stores", async () => {
    const conversationId = await seed(16);

    // The turn stores three rows: the system message, the user's and the reply.
    await finish(await read(conversationId, [fact(19)]), fact(17), fact(18));
    await settled(conversationId, 19, 1);

    const seen = visible(await read(conversationId));
    expect(facts(1, 19).filter((f) => !seen.includes(f))).toEqual([]);
  });
});
