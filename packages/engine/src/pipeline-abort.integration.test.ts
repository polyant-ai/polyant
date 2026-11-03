// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The post-response abort gate against a real database.
 *
 * A turn that the message coordinator aborts (a newer fragment arrived) is
 * re-run from scratch, so it must leave nothing behind: no user or assistant
 * row in `conversation_messages`, and none of the state its hooks wrote. The
 * unit tests check that the store functions are not CALLED; this file checks
 * that the rows are not THERE, with the real state buffer, conversation store
 * and persistence. Only the hook bodies (they abort the run) and
 * the title generator (an LLM call) are replaced. A control turn without the
 * abort proves the same setup does write both. Self-skips without a database;
 * CI_REQUIRE_DB makes an absent one a failure there.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HookEvent, HookEventPayload, HookExecutionSummary, HookRunContext } from "./hooks/hook-types.js";

const hookBehaviour = vi.hoisted(() => ({
  responseGenerated: undefined as undefined | ((ctx: HookRunContext) => void),
  responseSent: undefined as undefined | ((payload: HookEventPayload, ctx: HookRunContext) => void | Promise<void>),
}));

vi.mock("./hooks/hook-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks/hook-runner.js")>();
  return {
    ...actual,
    runHooks: async (
      event: HookEvent,
      payload: HookEventPayload,
      ctx: HookRunContext,
    ): Promise<HookExecutionSummary[]> => {
      if (event === "response_generated") hookBehaviour.responseGenerated?.(ctx);
      if (event === "response_sent") await hookBehaviour.responseSent?.(payload, ctx);
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
import { runPipelinePost, runPipelinePre, type PipelineContext } from "./pipeline.js";
import { MessageCoordinator } from "./channels/message-coordinator.js";
import type { IncomingMessage } from "./channels/types.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-abort-gate";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_state WHERE scope_key LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug = ${AGENT}`;
}

/** Run one post-response phase; `abortDuringHooks` aborts it from inside a hook. */
async function finishTurn(
  conversationId: string,
  abortDuringHooks: boolean,
  assistantMessageId?: string,
): Promise<void> {
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
    instanceConfig: { memoryEnabled: false, attachmentStorageEnabled: false, langsmith: { enabled: false } } as PipelineContext["instanceConfig"],
    langsmith: undefined,
    userAttachments: undefined,
    isAutoTaskTurn: false,
    inboundMetadata: undefined,
  };

  await runPipelinePost({
    ctx,
    contextPrepMs: 0,
    messageText: "open a ticket",
    channel: "web",
    resultText: "Ticket T-1 opened.",
    assistantMessageId,
    usage: { promptTokens: 0, completionTokens: 0 },
    durationMs: 0,
    toolBuildingMs: 0,
    isStreaming: false,
    abortSignal: controller.signal,
  });
}

/**
 * A turn as the channel handler runs it, with a canned reply standing in for
 * the model: the real context preparation, then the real post phase.
 */
async function cannedTurn(msg: IncomingMessage, signal: AbortSignal): Promise<{ text: string }> {
  const pre = await runPipelinePre(msg, undefined, signal);
  const { finalText } = await runPipelinePost({
    ctx: pre.ctx,
    contextPrepMs: pre.contextPrepMs,
    messageText: pre.messageText,
    channel: msg.channelType,
    resultText: `R(${pre.messageText})`,
    usage: { promptTokens: 0, completionTokens: 0 },
    durationMs: 0,
    toolBuildingMs: 0,
    isStreaming: false,
    abortSignal: signal,
  });
  return { text: finalText };
}

async function messages(conversationId: string): Promise<string[]> {
  const rows = await queryClient<{ role: string; content: string }[]>`
    SELECT role, content FROM conversation_messages WHERE conversation_id = ${conversationId} ORDER BY created_at`;
  return rows.map((r) => `${r.role}:${r.content}`);
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

  afterEach(() => {
    hookBehaviour.responseGenerated = undefined;
    hookBehaviour.responseSent = undefined;
  });

  it("writes the turn's messages and the hook's state when nothing aborts it", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;

    await finishTurn(conversationId, false);

    expect(await messageRoles(conversationId)).toEqual(["user", "assistant"]);
    expect(await storedState(conversationId)).toMatchObject({ ticket: "T-1" });
  });

  it("has written the turn by the time the post phase returns, before the reply can be sent", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;

    await finishTurn(conversationId, false);

    expect(await messageRoles(conversationId)).toEqual(["user", "assistant"]);
  });

  it("fails the turn and leaves no user row without its reply when the reply cannot be written", async () => {
    // A reply id that already exists makes the assistant insert fail.
    const taken = `${MARKER}-${randomUUID()}`;
    await conversationStore.ensureConversation(taken, AGENT, { channel: "web" });
    const takenId = randomUUID();
    await conversationStore.appendMessages(taken, [{ id: takenId, role: "user", content: "x" }]);
    const conversationId = `${MARKER}-${randomUUID()}`;

    await expect(finishTurn(conversationId, false, takenId)).rejects.toThrow();

    expect(await messageRoles(conversationId)).toEqual([]);
  });

  it("leaves no message and no state behind when the run is aborted while its hooks run", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;

    await finishTurn(conversationId, true);

    expect(await messageRoles(conversationId)).toEqual([]);
    expect(await storedState(conversationId)).toBeUndefined();
  });

  it("delivers and keeps a saved reply when the next fragment arrives while the turn is being saved", async () => {
    const channelId = randomUUID();
    const conversationId = `${AGENT}:whatsapp:${channelId}`;
    const sent: string[] = [];
    const coordinator = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 30, typingDelayMs: 10_000, maxRestarts: 3 }),
      handler: cannedTurn,
      sendOutbound: async (_agent, _channel, _id, text) => {
        sent.push(text);
      },
    });
    const fragment = (text: string): IncomingMessage => ({
      channelType: "whatsapp",
      channelId,
      instanceId: AGENT,
      text,
      metadata: {},
    });
    // The contact's second fragment lands after the first turn was saved,
    // while its response_sent hooks run.
    let injected = false;
    hookBehaviour.responseSent = () => {
      if (injected) return;
      injected = true;
      void coordinator.onMessage(fragment("b"));
    };

    await coordinator.onMessage(fragment("a"));

    await vi.waitFor(async () => expect((await messages(conversationId)).length).toBeGreaterThanOrEqual(4), {
      timeout: 5_000,
    });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));
    // Each saved reply was the one delivered, and "a" was saved once.
    expect(await messages(conversationId)).toEqual(["user:a", "assistant:R(a)", "user:b", "assistant:R(b)"]);
    await vi.waitFor(() => expect(sent).toEqual(["R(a)", "R(b)"]));
    coordinator.shutdown();
  });

  it("returns before slow response_sent hooks finish, and the next turn still reads the state they wrote", async () => {
    const channelId = randomUUID();
    const conversationId = `${AGENT}:web:${channelId}`;
    const msg = (text: string): IncomingMessage => ({ channelType: "web", channelId, instanceId: AGENT, text, metadata: {} });
    let finishHook!: () => void;
    const hookDone = new Promise<void>((resolve) => (finishHook = resolve));
    hookBehaviour.responseSent = async (_payload, ctx) => {
      await hookDone;
      ctx.state?.set("delivered", true);
    };

    const first = new AbortController();
    const turn = cannedTurn(msg("a"), first.signal);
    // The post phase does not wait for the delivery hooks: the reply can leave.
    await expect(Promise.race([turn.then(() => "returned"), new Promise((r) => setTimeout(() => r("waiting"), 1_000))]))
      .resolves.toBe("returned");

    hookBehaviour.responseSent = undefined;
    const next = runPipelinePre(msg("b"), undefined, new AbortController().signal);
    finishHook();
    const { ctx } = await next;
    expect(ctx.stateBuffer?.snapshot()).toMatchObject({ delivered: true });
  });
});
