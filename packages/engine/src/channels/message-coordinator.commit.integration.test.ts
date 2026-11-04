// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fragment that arrives after a turn has committed must not undo that turn.
 *
 * `runPipelinePost` writes the turn's messages (`afterResponse`) and only then
 * awaits the `response_sent` hooks. A second fragment that lands while those
 * hooks run aborts the coordinator's signal, and the coordinator used to read an
 * aborted signal on return as "cancelled, nothing persisted": it dropped the
 * reply and replayed the first fragment together with the second. The user never
 * got the first answer, and the history stored the first message twice next to
 * an answer nobody received.
 *
 * Real coordinator, real post-response phase, real hook runner, real database.
 * Only the hook lookup and bodies and the title generator (an LLM call) are
 * replaced; the handler stands in for the pre/LLM phases, which have nothing to
 * do with the commit point. Self-skips without a database; CI_REQUIRE_DB makes
 * an absent one a failure.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HookEvent, HookEventPayload, HookRunContext, InstanceHookRow } from "../hooks/hook-types.js";

const hooks = vi.hoisted(() => ({
  /** Body of every `response_sent` hook: the hook's id, the user message of the turn, the context it ran with. */
  responseSent: undefined as undefined | ((id: string, text: string, ctx: HookRunContext) => Promise<void>),
}));

/** An enabled `function` hook row; only the fields the runner reads matter. */
function hookRow(id: string, event: HookEvent, position: number): InstanceHookRow {
  return {
    id,
    instanceId: "itest-commit-point",
    event,
    actionType: "function",
    actionConfig: { functionName: `itest-${id}` },
    enabled: true,
    position,
    timeoutMs: 10_000,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

vi.mock("../hooks/hooks.store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/hooks.store.js")>();
  return {
    ...actual,
    getEnabledHooks: async (_instance: string, event: HookEvent) =>
      event === "response_sent" ? [hookRow("a", event, 0), hookRow("b", event, 1)] : [],
  };
});
vi.mock("../hooks/actions/function-action.js", () => ({
  functionActionExecutor: {
    execute: async (hook: InstanceHookRow, payload: HookEventPayload, ctx: HookRunContext) => {
      await hooks.responseSent?.(hook.id, payload.message.text, ctx);
    },
  },
}));
vi.mock("../hooks/hook-executions.store.js", () => ({ recordHookExecution: async () => undefined }));
vi.mock("../utils/title-generator.js", () => ({ generateConversationTitle: async () => undefined }));

import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { conversationStore } from "../conversations/index.js";
import { ConversationStateBuffer } from "../conversations/state.buffer.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { runPipelinePost, type PipelineContext } from "../pipeline.js";
import { drainBackgroundTurns } from "./background-turns.js";
import { MessageCoordinator } from "./message-coordinator.js";
import type { IncomingMessage, OutgoingMessage } from "./types.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const AGENT = asInstanceSlug("itest-commit-point-agent");
const CHAT = "chat-1";
// Written out, not derived with the production helper.
const CONVERSATION_ID = `${AGENT}:telegram:${CHAT}`;

/** Removes every row this test writes, keyed by its agent slug. */
async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_state WHERE scope_key LIKE ${AGENT + "%"}`;
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${AGENT + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug = ${AGENT}`;
}

/** One inbound Telegram fragment for the test conversation. */
function fragment(text: string): IncomingMessage {
  return { channelType: "telegram", channelId: CHAT, instanceId: AGENT, text, metadata: {} };
}

/**
 * The coordinator's handler: the post-response phase of a turn that answers
 * `echo: <text>`, returning its commit outcome as `runBufferedTurn` does.
 */
async function turn(msg: IncomingMessage, signal: AbortSignal): Promise<OutgoingMessage> {
  await conversationStore.ensureConversation(CONVERSATION_ID, AGENT, { channel: "telegram" });
  const ctx: PipelineContext = {
    pipelineStart: Date.now(),
    instanceId: AGENT,
    conversationId: CONVERSATION_ID,
    conversationSummary: undefined,
    contextPrompt: undefined,
    channelIdentity: { channel: "telegram", channelId: CHAT },
    stateBuffer: await ConversationStateBuffer.load(CONVERSATION_ID, AGENT),
    history: undefined,
    isFirstTurn: false,
    hasOverflow: false,
    droppedMessages: undefined,
    instanceConfig: { memoryEnabled: false, attachmentStorageEnabled: false } as PipelineContext["instanceConfig"],
    langsmith: undefined,
    userAttachments: undefined,
    incomingSystemMessages: undefined,
    isAutoTaskTurn: false,
    inboundMetadata: undefined,
  };
  const { finalText, committed } = await runPipelinePost({
    ctx,
    contextPrepMs: 0,
    messageText: msg.text,
    channel: msg.channelType,
    resultText: `echo: ${msg.text}`,
    usage: { promptTokens: 0, completionTokens: 0 },
    durationMs: 0,
    toolBuildingMs: 0,
    isStreaming: false,
    abortSignal: signal,
  });
  return { text: finalText, committed };
}

/** The conversation's stored messages, oldest first, as `role: content`. */
async function storedMessages(): Promise<string[]> {
  const rows = await queryClient<{ role: string; content: string }[]>`
    SELECT role, content FROM conversation_messages
    WHERE conversation_id = ${CONVERSATION_ID} ORDER BY created_at`;
  return rows.map((r) => `${r.role}: ${r.content}`);
}

describe.skipIf(!DB_AVAILABLE)("message coordinator × commit point (integration)", () => {
  beforeAll(async () => {
    await teardown();
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${AGENT}, 'commit point', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))`;
  });

  afterAll(teardown);

  it("delivers a committed reply, runs all its response_sent hooks and does not replay its fragment when a new one arrives during them", async () => {
    let enteredResponseSent!: () => void;
    const inResponseSent = new Promise<void>((resolve) => (enteredResponseSent = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const ran: string[] = [];
    const abortedWhenDone: string[] = [];
    hooks.responseSent = async (id, text, ctx) => {
      ran.push(`${id}:${text}`);
      if (id === "a" && text === "first") {
        enteredResponseSent();
        await released;
      }
      // Each hook leaves a mark in the conversation state, written after the
      // second fragment has arrived for hook a of the first turn.
      ctx.state?.set(`${id}:${text}`, true);
      if (ctx.abortSignal?.aborted) abortedWhenDone.push(`${id}:${text}`);
    };

    const sent: string[] = [];
    const coordinator = new MessageCoordinator({
      resolveTimings: async () => ({ softDebounceMs: 20, typingDelayMs: 0, maxRestarts: 3 }),
      handler: turn,
      sendOutbound: async (_slug, _type, _id, text) => {
        sent.push(text);
      },
    });

    try {
      await coordinator.onMessage(fragment("first"));
      // Turn 1 is past its last abort gate: its messages are being written and
      // its first response_sent hook is running.
      await inResponseSent;
      await coordinator.onMessage(fragment("second"));
      release();

      expect((await drainBackgroundTurns(10_000)).pending).toBe(0);
      await vi.waitFor(async () => expect((await storedMessages()).length).toBeGreaterThanOrEqual(4), {
        timeout: 5_000,
      });
      expect(await storedMessages()).toEqual([
        "user: first",
        "assistant: echo: first",
        "user: second",
        "assistant: echo: second",
      ]);
      expect(sent).toEqual(["echo: first", "echo: second"]);
      // The committed turn's hooks all ran once, to the end, and their state writes were kept.
      expect(ran).toEqual(["a:first", "b:first", "a:second", "b:second"]);
      expect(abortedWhenDone).toEqual([]);
      const state = (await ConversationStateBuffer.load(CONVERSATION_ID, AGENT)).snapshot();
      expect(state).toMatchObject({ "a:first": true, "b:first": true, "a:second": true, "b:second": true });
    } finally {
      coordinator.shutdown();
    }
  });
});
