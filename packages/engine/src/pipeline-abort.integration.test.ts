// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The post-response abort gate against a real database.
 *
 * A turn that the message coordinator aborts (a newer fragment arrived) is
 * re-run from scratch, so it must leave nothing behind: no user or assistant
 * row in `conversation_messages`, and none of the state its hooks wrote. The
 * unit tests check that the store functions are not CALLED; this file checks
 * that the rows are not THERE, with the real state buffer, conversation store
 * and fire-and-forget persistence. Only the hook bodies (they abort the run) and
 * the title generator (an LLM call) are replaced. A control turn without the
 * abort proves the same setup does write both. Self-skips without a database;
 * CI_REQUIRE_DB makes an absent one a failure there.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HookEvent, HookEventPayload, HookExecutionSummary, HookRunContext } from "./hooks/hook-types.js";

const hookBehaviour = vi.hoisted(() => ({
  responseGenerated: undefined as undefined | ((ctx: HookRunContext) => void),
}));

vi.mock("./hooks/hook-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/hook-runner.js")>();
  return {
    ...actual,
    runHooks: async (
      event: HookEvent,
      _payload: HookEventPayload,
      ctx: HookRunContext,
    ): Promise<HookExecutionSummary[]> => {
      if (event === "response_generated") hookBehaviour.responseGenerated?.(ctx);
      return [];
    },
  };
});
vi.mock("./utils/title-generator.js", () => ({ generateConversationTitle: async () => undefined }));

import { queryClient } from "./database/client.js";
import { resolveDatabaseAvailability } from "./database/test-db.js";
import { conversationStore } from "./conversations/index.js";
import { ConversationStateBuffer } from "./conversations/state.buffer.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import { runPipelinePost, type PipelineContext } from "./pipeline.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-abort-gate";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_state WHERE scope_key LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug = ${AGENT}`;
}

/** Run one post-response phase; `abortDuringHooks` aborts it from inside a hook. */
async function finishTurn(conversationId: string, abortDuringHooks: boolean): Promise<void> {
  await conversationStore.ensureConversation(conversationId, AGENT, { channel: "web" });
  const stateBuffer = await ConversationStateBuffer.load(conversationId, AGENT);
  const controller = new AbortController();

  hookBehaviour.responseGenerated = (ctx) => {
    ctx.state?.set("ticket", "T-1");
    if (abortDuringHooks) controller.abort();
  };

  const ctx: PipelineContext = {
    pipelineStart: Date.now(),
    instanceId: AGENT,
    conversationId,
    conversationSummary: undefined,
    contextPrompt: undefined,
    channelIdentity: { channel: "web", channelId: conversationId },
    stateBuffer,
    history: undefined,
    isFirstTurn: true,
    hasOverflow: false,
    droppedMessages: undefined,
    instanceConfig: { memoryEnabled: false, attachmentStorageEnabled: false } as PipelineContext["instanceConfig"],
    langsmith: undefined,
    userAttachments: undefined,
    incomingSystemMessages: undefined,
    isAutoTaskTurn: false,
    inboundMetadata: undefined,
  };

  await runPipelinePost({
    ctx,
    contextPrepMs: 0,
    messageText: "open a ticket",
    channel: "web",
    resultText: "Ticket T-1 opened.",
    usage: { promptTokens: 0, completionTokens: 0 },
    durationMs: 0,
    toolBuildingMs: 0,
    isStreaming: false,
    abortSignal: controller.signal,
  });
}

async function messageRoles(conversationId: string): Promise<string[]> {
  const rows = await queryClient<{ role: string }[]>`
    SELECT role FROM conversation_messages WHERE conversation_id = ${conversationId} ORDER BY created_at`;
  return rows.map((r) => r.role);
}

async function storedState(conversationId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await queryClient<{ data: Record<string, unknown> }[]>`
    SELECT data FROM conversation_state WHERE scope_key = ${conversationId}`;
  return rows[0]?.data;
}

describe.skipIf(!DB_AVAILABLE)("post-response abort gate (integration)", () => {
  beforeAll(async () => {
    await teardown();
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${AGENT}, 'abort gate', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))`;
  });

  afterAll(teardown);

  it("writes the turn's messages and the hook's state when nothing aborts it", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;

    await finishTurn(conversationId, false);

    await vi.waitFor(async () => expect(await messageRoles(conversationId)).toEqual(["user", "assistant"]), {
      timeout: 5_000,
    });
    expect(await storedState(conversationId)).toMatchObject({ ticket: "T-1" });
  });

  it("leaves no message and no state behind when the run is aborted while its hooks run", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;

    await finishTurn(conversationId, true);

    // The persistence is fire-and-forget; give it the time the control needed.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await messageRoles(conversationId)).toEqual([]);
    expect(await storedState(conversationId)).toBeUndefined();
  });
});
