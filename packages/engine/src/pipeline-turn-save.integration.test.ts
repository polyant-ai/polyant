// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How a finished turn's question and answer reach `conversation_messages`, against a real database.
 *
 * Both rows are written by one `appendMessages` call: one transaction and one update of the conversation row
 * for the pair. The question keeps its arrival time and the answer the database's now(), so the question sorts
 * first. When the database rejects the pair, the rows are written one at a time as before, so a question whose
 * answer cannot be saved is still saved with the keys of its uploaded attachments (the cleanup of a deleted
 * conversation or agent finds a stored file only through them). Only the hooks, the title generator (an LLM call)
 * and the attachment upload (object storage) are replaced. Self-skips without a database; CI_REQUIRE_DB makes an
 * absent one a failure there.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./hooks/hook-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/hook-runner.js")>();
  return { ...actual, runHooks: async () => [] };
});
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: async () => undefined }));
vi.mock("./attachments/agent-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attachments/agent-storage.js")>();
  return {
    ...actual,
    uploadAttachment: async (data: Buffer, o: { type: string; mimeType?: string; fileName?: string; conversationId: string }) =>
      ({ type: o.type, mimeType: o.mimeType, fileName: o.fileName, s3Key: `${o.conversationId}/${o.fileName}`, sizeBytes: data.length }),
  };
});

import { queryClient } from "./database/client.js";
import { resolveDatabaseAvailability } from "./database/test-db.js";
import { conversationStore } from "./conversations/index.js";
import { ConversationStateBuffer } from "./conversations/state.buffer.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import { runPipelinePost, type PipelineContext } from "./pipeline.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-turn-save";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

/** Remove every row this file creates (agent, conversations, messages, state). */
async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_state WHERE scope_key LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug = ${AGENT}`;
}

/** Run one post-response phase for a turn that arrived at `receivedAt`, with a pre-generated answer id. */
async function finishTurn(
  conversationId: string,
  receivedAt: number,
  assistantMessageId: string,
  userAttachments?: PipelineContext["userAttachments"],
): Promise<void> {
  await conversationStore.ensureConversation(conversationId, AGENT, { channel: "web" });
  const ctx: PipelineContext = {
    pipelineStart: receivedAt,
    instanceId: AGENT,
    conversationId,
    conversationSummary: undefined,
    contextPrompt: undefined,
    channelIdentity: { channel: "web", channelId: conversationId },
    stateBuffer: await ConversationStateBuffer.load(conversationId, AGENT),
    history: undefined,
    isFirstTurn: true,
    hasOverflow: false,
    droppedMessages: undefined,
    instanceConfig: { memoryEnabled: false, attachmentStorageEnabled: userAttachments !== undefined } as PipelineContext["instanceConfig"],
    langsmith: undefined,
    userAttachments,
    incomingSystemMessages: undefined,
    isAutoTaskTurn: false,
    inboundMetadata: undefined,
  };
  await runPipelinePost({
    ctx,
    contextPrepMs: 0,
    messageText: "where is my order?",
    channel: "web",
    resultText: "It ships tomorrow.",
    usage: { promptTokens: 0, completionTokens: 0 },
    durationMs: 0,
    toolBuildingMs: 0,
    isStreaming: true,
    assistantMessageId,
  });
}

const rows = (conversationId: string) => queryClient<{ id: string; role: string; created_at: Date; xmin: string; attachments: unknown }[]>`
  SELECT id::text, role, created_at, xmin::text, attachments FROM conversation_messages
  WHERE conversation_id = ${conversationId} ORDER BY created_at`;
const counters = async (conversationId: string) => {
  const [c] = await queryClient<{ message_count: number; user_message_count: number }[]>`
    SELECT message_count, user_message_count FROM conversations WHERE conversation_id = ${conversationId}`;
  return c;
};

describe.skipIf(!DB_AVAILABLE)("saving a finished turn (integration)", () => {
  beforeAll(async () => {
    await teardown();
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${AGENT}, 'turn save', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))`;
  });

  afterAll(teardown);

  it("writes the question and the answer in one transaction, the question first at its arrival time", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;
    const answerId = randomUUID();
    const receivedAt = Date.now() - 2_000;   // the turn took two seconds

    await finishTurn(conversationId, receivedAt, answerId);

    await vi.waitFor(async () => expect((await rows(conversationId)).map((r) => r.role)).toEqual(["user", "assistant"]), {
      timeout: 5_000,
    });
    const [question, answer] = await rows(conversationId);
    expect(new Date(question.created_at).getTime()).toBe(receivedAt);
    expect(new Date(answer.created_at).getTime()).toBeGreaterThan(receivedAt);
    expect(answer.id).toBe(answerId);
    expect(answer.xmin).toBe(question.xmin);   // written by the same transaction
    expect(await counters(conversationId)).toEqual({ message_count: 2, user_message_count: 1 });
  });

  it("still saves the question with its attachment's key when its answer cannot be written", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;
    // An answer id another row already holds: the answer's insert fails with a unique violation.
    const taken = randomUUID();
    const other = `${MARKER}-other-${randomUUID()}`;
    await conversationStore.ensureConversation(other, AGENT, { channel: "web" });
    await conversationStore.appendMessages(other, [{ id: taken, role: "assistant", content: "already here" }]);

    await finishTurn(conversationId, Date.now(), taken, [
      { type: "image", mimeType: "image/png", fileName: "receipt.png", data: Buffer.from("png") },
    ]);

    // The persistence is fire-and-forget and its error is logged.
    await vi.waitFor(async () => expect((await rows(conversationId)).map((r) => r.role)).toEqual(["user"]), { timeout: 5_000 });
    const [question] = await rows(conversationId);
    expect(question.attachments).toMatchObject([{ s3Key: `${conversationId}/receipt.png` }]);
    expect(await counters(conversationId)).toEqual({ message_count: 1, user_message_count: 1 });
  });
});
