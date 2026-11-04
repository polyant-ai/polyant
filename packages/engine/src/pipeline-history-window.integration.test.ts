// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A long conversation against a real database: on every turn the model must
 * be able to see every earlier message, either in the history it is sent or
 * in the conversation summary, and between two summaries the history must
 * only grow at its end, so the prefix a provider cached on one turn is the
 * prefix of the next.
 *
 * The real context preparation and post phase run; a canned reply stands in
 * for the model, and the summary model echoes what it was asked to summarize,
 * so a message that reached the summary can be found in it. Self-skips
 * without a database; CI_REQUIRE_DB makes an absent one a failure there.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

const summaryCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("./ai-gateway/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-gateway/index.js")>();
  return {
    ...actual,
    chat: async (request: { messages: Array<{ content: string }> }) => {
      summaryCalls.count++;
      return { text: request.messages.map((m) => m.content).join("\n") };
    },
  };
});
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: async () => undefined }));
vi.mock("./memory/index.js", () => ({ extractMemories: async () => [] }));
vi.mock("./hooks/hook-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/hook-runner.js")>();
  return { ...actual, runHooks: async () => [] };
});

import { queryClient } from "./database/client.js";
import { resolveDatabaseAvailability } from "./database/test-db.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import { runPipelinePost, runPipelinePre } from "./pipeline.js";
import { drainBackgroundTurns } from "./channels/background-turns.js";
import type { IncomingMessage } from "./channels/types.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-history-window";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_state WHERE scope_key LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug = ${AGENT}`;
}

function texts(history: ModelMessage[] | undefined): string[] {
  return (history ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

describe.skipIf(!DB_AVAILABLE)("conversation history window (integration)", () => {
  beforeAll(async () => {
    await teardown();
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${AGENT}, 'history window', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))`;
  });

  afterAll(teardown);

  it("shows the model every earlier message on every turn, and only appends to the history between summaries", async () => {
    const channelId = randomUUID();
    const sent: string[] = [];
    let previous: { history: string[]; summary: string | undefined } | undefined;
    summaryCalls.count = 0;
    const TURNS = 24;

    for (let turn = 1; turn <= TURNS; turn++) {
      const msg: IncomingMessage = { channelType: "web", channelId, instanceId: AGENT, text: `m${turn}`, metadata: {} };
      const signal = new AbortController().signal;
      const pre = await runPipelinePre(msg, undefined, signal);
      const history = texts(pre.ctx.history);
      const summary = pre.ctx.conversationSummary;

      // Everything said before this turn is in the history or in the summary.
      const visible = (text: string) => history.includes(text) || (summary ?? "").includes(text);
      const missing = sent.filter((text) => !visible(text));
      expect(missing, `turn ${turn}`).toEqual([]);

      // Between two summaries the history keeps its prefix.
      if (previous && previous.summary === summary) {
        expect(history.slice(0, previous.history.length), `turn ${turn}`).toEqual(previous.history);
      }
      previous = { history, summary };

      await runPipelinePost({
        ctx: pre.ctx,
        contextPrepMs: pre.contextPrepMs,
        messageText: pre.messageText,
        channel: "web",
        resultText: `R(m${turn})`,
        usage: { promptTokens: 0, completionTokens: 0 },
        durationMs: 0,
        toolBuildingMs: 0,
        isStreaming: false,
        abortSignal: signal,
      });
      sent.push(`m${turn}`, `R(m${turn})`);
      await drainBackgroundTurns(5_000);
    }

    // One summary per block of messages, not one per turn.
    expect(summaryCalls.count).toBeLessThanOrEqual(3);
  });

  // More messages after the summary than a turn reads: summaries that kept
  // failing, or rows written without a turn (reminders, webhook replies).
  it("summarizes the messages a turn did not read when more than it reads have piled up", async () => {
    const channelId = randomUUID();
    const conversationId = `${AGENT}:web:${channelId}`;
    const msg: IncomingMessage = { channelType: "web", channelId, instanceId: AGENT, text: "next", metadata: {} };
    await runPipelinePre(msg, undefined, new AbortController().signal);
    await queryClient`
      INSERT INTO conversation_messages (conversation_id, role, content, created_at)
      SELECT ${conversationId}, CASE WHEN n % 2 = 1 THEN 'user' ELSE 'assistant' END, 'p' || n,
             now() - interval '1 day' + n * interval '1 minute'
      FROM generate_series(1, 50) n`;

    const signal = new AbortController().signal;
    const pre = await runPipelinePre(msg, undefined, signal);
    await runPipelinePost({
      ctx: pre.ctx,
      contextPrepMs: pre.contextPrepMs,
      messageText: pre.messageText,
      channel: "web",
      resultText: "R(next)",
      usage: { promptTokens: 0, completionTokens: 0 },
      durationMs: 0,
      toolBuildingMs: 0,
      isStreaming: false,
      abortSignal: signal,
    });
    await drainBackgroundTurns(5_000);

    // Every message is either in the summary or in the next turn's history.
    const next = await runPipelinePre(msg, undefined, new AbortController().signal);
    const history = texts(next.ctx.history);
    const summary = next.ctx.conversationSummary ?? "";
    const lines = (text: string) => text.split("\n").map((line) => line.replace(/^(User|Assistant|System): /, ""));
    const missing = Array.from({ length: 50 }, (_, i) => `p${i + 1}`).filter(
      (text) => !history.includes(text) && !lines(summary).includes(text),
    );
    expect(missing).toEqual([]);
  });

  it("starts a turn on an existing conversation without rewriting its row, and still reads its context prompt", async () => {
    const channelId = randomUUID();
    const conversationId = `${AGENT}:web:${channelId}`;
    const msg: IncomingMessage = { channelType: "web", channelId, instanceId: AGENT, text: "hi", metadata: {} };
    await runPipelinePre(msg, undefined, new AbortController().signal);
    await queryClient`UPDATE conversations SET context_prompt = 'follow up on the order' WHERE conversation_id = ${conversationId}`;
    const version = async () =>
      (await queryClient<{ xmin: string }[]>`SELECT xmin::text FROM conversations WHERE conversation_id = ${conversationId}`)[0]?.xmin;
    const before = await version();

    const { ctx } = await runPipelinePre(msg, undefined, new AbortController().signal);

    expect(ctx.contextPrompt).toBe("follow up on the order");
    expect(await version()).toBe(before);
  });
});
