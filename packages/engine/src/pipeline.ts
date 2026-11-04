// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Pipeline — Extracted shared logic for message handling
// ---------------------------------------------------------------------------
// Houses preparePipeline, persistTurn, afterResponseTail, runPipelinePre, runPipelinePost,
// and module-level helpers (isAutoTask, isMissingApiKeyError, MISSING_KEY_RESPONSE).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { InstanceSlug } from "./instances/identifiers.js";
import { chat } from "./ai-gateway/index.js";
import type { CostBreakdown } from "./ai-gateway/types.js";
import { conversationStore } from "./conversations/index.js";
import { ConversationStateBuffer } from "./conversations/state.buffer.js";
import {
  buildExactHistory,
  buildHistoryWithToolResults,
  toExactUserMessage,
  type ExactTurn,
} from "./conversations/tool-history.js";
import { rowsToModelMessages, type ConversationTurnContext, type MessageRow } from "./conversations/store.js";
import { HISTORY_HARD_CAP, messagesToFold } from "./conversations/history-window.js";
import { extractMemories } from "./memory/index.js";
import { pipelineLog } from "./utils/pipeline-logger.js";
import { contactConversationId } from "./channels/outbound-conversation.js";
import { runBackgroundJob, trackBackgroundTurn } from "./channels/background-turns.js";
import { generateConversationTitle } from "./utils/title-generator.js";
import { resolveInstanceConfig, type InstanceConfig } from "./instances/config-resolver.js";
import { traceStore } from "./analytics/trace.store.js";
import { uploadAttachment } from "./attachments/agent-storage.js";
import type { AttachmentMeta, StepDetail, ReasoningDetail, LlmDebugPayload } from "./conversations/schema.js";
import type { AgentCallMetadata, Attachment, IncomingMessage, OutgoingMessage, StreamOutgoingMessage } from "./channels/types.js";
import type { ToolCallTrace } from "./analytics/traces.schema.js";
import { emitInbound } from "./activity-stream/emitters/emit-inbound.js";
import { emitConversation } from "./activity-stream/emitters/emit-conversation.js";
import { resolveInstanceMeta } from "./activity-stream/emit-helpers.js";
import { runHooks, firstHalt, firstReplaceResponse, firstRegenerate, collectInjectContext, hookProvenance, type HookProvenance } from "./hooks/hook-runner.js";
import type { HookEventPayload, HookExecutionSummary, HookRunContext } from "./hooks/hook-types.js";
import { getEnabledHooks } from "./hooks/hooks.store.js";
import { getHookRegistry } from "./hooks/hook-registry.js";
import { startMcpConnections } from "./agents/tools/mcp/mcp-tools.js";
import type { McpServerRecord } from "./instances/mcp-servers.store.js";
import type { ResponseGeneratedOutcome } from "./hooks/response-replay.js";
import { resolveDatetimeSettings, UNSET_AGENT_SETTINGS } from "./instances/agent-settings.js";
import { createLogger } from "./utils/create-logger.js";

const log = createLogger();

/**
 * Channel types that should NOT produce `category: "inbound"` events:
 *   - `agent`     → covered by `emitAgentHandoffStart`/`End` (dual-avatar row)
 *   - `scheduled` → covered by `emitCron` (fires before the message handler)
 *   - `room`      → event-driven, no inbound user message
 * Anything else (telegram/whatsapp/slack/web/openai/…) emits.
 */
const INBOUND_SUPPRESSED_CHANNELS = new Set(["agent", "scheduled", "room"]);

// ---------------------------------------------------------------------------
// Module-level helpers (moved out of main() closure)
// ---------------------------------------------------------------------------

/** Detect automated Open WebUI task messages (title/tag generation). */
export function isAutoTask(text: string): boolean {
  return text.startsWith("### Task:");
}

/** Extract STT audio fields from inbound metadata for trace recording. */
function extractSttFields(inboundMetadata: Record<string, unknown> | undefined): {
  sttProvider: string | null;
  audioDurationSec: string | null;
  sttDurationMs: number | null;
} {
  if (inboundMetadata?.originalKind !== "audio") {
    return { sttProvider: null, audioDurationSec: null, sttDurationMs: null };
  }
  const audio = inboundMetadata.audio as
    | { durationSec?: number; sttProvider?: string; latencyMs?: number }
    | undefined;
  return {
    sttProvider: audio?.sttProvider ?? null,
    audioDurationSec: typeof audio?.durationSec === "number" ? String(audio.durationSec) : null,
    sttDurationMs: typeof audio?.latencyMs === "number" ? audio.latencyMs : null,
  };
}

/** Check if an error is caused by a missing AI provider API key. */
export function isMissingApiKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("api key not configured") || msg.includes("api key required");
}

/** Friendly message returned when the AI provider key is not set for the instance. */
export const MISSING_KEY_RESPONSE =
  "⚠️ This AI assistant instance does not have an API key configured for its AI provider. " +
  "Please open this agent in the admin panel, go to its Model section and set the API key " +
  "of its AI provider to enable this assistant.";

/** The turn's outcome when the agent has no provider key: the warning, marked as a failure. */
export function missingKeyOutgoing(): OutgoingMessage {
  return { text: MISSING_KEY_RESPONSE, failure: "missing_provider_key" };
}

/** Streaming form of {@link missingKeyOutgoing}: one text chunk, marked as a failure up front. */
export function missingKeyStream(): StreamOutgoingMessage {
  return {
    failure: "missing_provider_key",
    textStream: (async function* () { yield MISSING_KEY_RESPONSE; })(),
    fullStream: (async function* () { yield { type: "text-delta", text: MISSING_KEY_RESPONSE }; })(),
    completed: Promise.resolve({ text: MISSING_KEY_RESPONSE }),
  };
}

/**
 * The oldest messages of the history, to fold into the summary after the turn
 * (see `conversations/history-window.ts`).
 */
export interface SummaryFold {
  messages: ModelMessage[];
  /** created_at of the last of them: where the summary will reach. */
  through: Date;
  /** Where the summary reached when the turn read it. */
  previousThrough: Date | null;
}

// ---------------------------------------------------------------------------
// PipelineContext — everything preparePipeline returns
// ---------------------------------------------------------------------------

export interface PipelineContext {
  pipelineStart: number;
  instanceId: InstanceSlug;
  conversationId: string;
  conversationSummary: string | undefined;
  contextPrompt: string | undefined;
  channelIdentity: { channel: string; channelId: string; userName?: string } | undefined;
  /** Per-run shared conversation state buffer (commit-on-success). Undefined on auto-task turns. */
  stateBuffer: ConversationStateBuffer | undefined;
  /** The channel's point of no return (`IncomingMessage.commitGate`), asked once before the turn is saved. */
  commitGate?: () => boolean;
  history: ModelMessage[] | undefined;
  /** True when no message rows were persisted before this turn (first successful turn). */
  isFirstTurn: boolean;
  /** Set when this turn takes the history past its window: what to fold into the summary once it is saved. */
  summaryFold?: SummaryFold;
  instanceConfig: InstanceConfig;
  langsmith: { apiKey: string; project: string } | undefined;
  /** Attachments to persist alongside the user message, once the pipeline has succeeded. */
  userAttachments: Attachment[] | undefined;
  /** Whether this turn is an automated Open WebUI task (title/tag gen) — persistence skipped. */
  isAutoTaskTurn: boolean;
  /** Raw inbound metadata (e.g. audio STT block) — forwarded to the saved user message row. */
  inboundMetadata: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// preparePipeline — context prep phase (extracted from ~lines 222-296)
// ---------------------------------------------------------------------------

/** Build LangSmith config from instance config, or undefined if not enabled. */
function buildLangsmithConfig(cfg: InstanceConfig): { apiKey: string; project: string } | undefined {
  if (!cfg.langsmith.enabled || !cfg.langsmith.apiKey) return undefined;
  return { apiKey: cfg.langsmith.apiKey, project: cfg.langsmith.project ?? "default" };
}

/**
 * `response_sent` work still running, by conversation. The conversation's next
 * turn waits for it before reading the state, so a delivery hook that writes is
 * never read stale. Process-local, like the message coordinator.
 */
const deliveryHooks = new Map<string, Promise<void>>();

function holdNextTurn(conversationId: string, work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    (err: unknown) => log.error("pipeline", `response_sent hooks failed for ${conversationId}`, err),
  );
  deliveryHooks.set(conversationId, settled);
  trackBackgroundTurn(settled);
  void settled.then(() => {
    if (deliveryHooks.get(conversationId) === settled) deliveryHooks.delete(conversationId);
  });
}

export async function preparePipeline(
  msg: IncomingMessage,
  conversationIdOverride?: string | null,
): Promise<PipelineContext> {
  const pipelineStart = Date.now();
  const instanceId: InstanceSlug = msg.instanceId;
  pipelineLog.request(msg.channelType, instanceId, msg.text);

  const conversationId = conversationIdOverride
    ?? msg.conversationId
    ?? contactConversationId(instanceId, msg.channelType, msg.channelId);
  const isAutoTaskTurn = isAutoTask(msg.text);
  const source = (msg.metadata?.source as string) ?? "user";

  // The conversation row first (its summary says where the history starts),
  // then the history; the config and the state meanwhile. Automated tasks
  // (e.g. Open WebUI title/tag generation) read the row without creating it.
  const instanceConfigPromise = resolveInstanceConfig(instanceId);
  const turnPromise = conversationStore
    .openConversationTurn(
      conversationId,
      instanceId,
      isAutoTaskTurn ? undefined : { channel: msg.channelType, userIdentifier: msg.userName, source },
    )
    .catch((err): ConversationTurnContext => {
      log.error("pipeline", `Failed to open conversation ${conversationId}`, err);
      return { created: false, contextPrompt: null, summary: null, summaryThrough: null };
    });
  // Tool-result replay (opt-in per agent) reads the rows with their steps, and
  // exact replay with the messages each row was sent as.
  const replayPromise = instanceConfigPromise.then((config) => config.toolResultsInHistoryEnabled && !isAutoTaskTurn);
  const historyPromise = Promise.all([turnPromise, replayPromise, instanceConfigPromise]).then(([turn, withSteps, config]) =>
    conversationStore
      .getHistoryWindow(conversationId, {
        after: turn.summaryThrough,
        limit: HISTORY_HARD_CAP,
        withSteps,
        withExactReplay: withSteps && config.toolHistoryReplay === "exact",
      })
      .catch(() => [] as MessageRow[]),
  );
  const [turn, rows, replay, instanceConfig, stateBuffer] = await Promise.all([
    turnPromise,
    historyPromise,
    replayPromise,
    instanceConfigPromise,
    isAutoTaskTurn
      ? Promise.resolve(undefined)
      : Promise.resolve(deliveryHooks.get(conversationId))
          .then(() => ConversationStateBuffer.load(conversationId, instanceId))
          .catch((err) => {
            log.error("pipeline", `Failed to load conversation state for ${conversationId}`, err);
            return new ConversationStateBuffer(conversationId, instanceId);
          }),
  ]);
  const contextPrompt = turn.contextPrompt ?? undefined;

  if (!isAutoTaskTurn) {
    // Activity-stream emit: lifecycle event when a brand-new conversation row
    // is created (never on subsequent turns of the same conversation).
    // Skipped for synthetic channels covered by other emitters.
    if (turn.created && !INBOUND_SUPPRESSED_CHANNELS.has(msg.channelType)) {
      resolveInstanceMeta(instanceId)
        .then((instance) => {
          emitConversation({
            conversationId,
            lifecycle: "created",
            source,
            channel: msg.channelType,
            instance,
          });
        })
        .catch(() => {
          /* swallow */
        });
    }

    // Activity-stream emit: surface the inbound user message BEFORE the
    // supervisor runs. Skipped for auto-tasks (handled above) and for synthetic
    // channels covered by other emitters (agent/scheduled/room).
    // Fire-and-forget; the emitter is safeEmit-wrapped.
    if (!INBOUND_SUPPRESSED_CHANNELS.has(msg.channelType)) {
      resolveInstanceMeta(instanceId)
        .then((instance) => {
          emitInbound({
            channelType: msg.channelType,
            channelId: msg.channelId,
            sender: msg.userName,
            text: msg.text,
            conversationId,
            instance,
          });
        })
        .catch(() => {
          /* resolveInstanceMeta swallows internally; guard the chain */
        });
    }
  }

  // First persisted turn — computed from PERSISTED rows, NOT the metadata
  // fallback below: the OpenAI-compat path passes client-side history that must
  // not suppress the conversation_start hook. Abort-safe by construction: an
  // aborted run persists nothing, so the restarted run still sees zero rows.
  const isFirstTurn = rows.length === 0 && turn.summaryThrough === null;

  // NOTE: the user message is NOT persisted here. `persistTurn()` writes it
  // only after the pipeline succeeds, so that an aborted pipeline
  // (cancel-and-restart) leaves no trace in DB.

  // The summary covers everything before the history: both go to the model.
  const conversationSummary = turn.summary ?? undefined;
  const conversationHistory = rowsToModelMessages(rows);
  let history: ModelMessage[] | undefined;
  if (rows.length === 0) {
    history = msg.metadata?.conversationHistory as ModelMessage[] | undefined;
  } else {
    // Tool-result replay rebuilds tool_use/tool_result blocks from the persisted
    // `steps`, so the model retains tool outputs across turns. Exact replay sends
    // each row's messages as they were sent; a thinking block is bound to
    // everything before it, so reasoning is replayed only while the history
    // still starts where the conversation does (nothing folded, nothing cut).
    history = !replay
      ? conversationHistory
      : instanceConfig.toolHistoryReplay === "exact"
        ? buildExactHistory(rows, { keepReasoning: turn.summaryThrough === null && rows.length < HISTORY_HARD_CAP })
        : buildHistoryWithToolResults(rows);
  }

  // This turn adds two messages: when that takes the history past its window,
  // the oldest are folded into the summary after the turn is saved.
  const fold = isAutoTaskTurn ? 0 : messagesToFold(rows, 2);
  const summaryFold: SummaryFold | undefined =
    fold > 0
      ? {
          messages: conversationHistory.slice(0, fold),
          through: rows[fold - 1].createdAt!,
          previousThrough: turn.summaryThrough,
        }
      : undefined;

  const langsmith = buildLangsmithConfig(instanceConfig);

  // Build channel identity — injected into the system prompt so the agent
  // always knows who it is talking to, regardless of channel.
  const channelIdentity = isAutoTaskTurn
    ? undefined
    : { channel: msg.channelType, channelId: msg.channelId, userName: msg.userName };

  // Seed the trusted channel identity into the shared state under `_channel` for
  // real user channels (skip synthetic agent/scheduled/room conversations).
  if (stateBuffer && channelIdentity && !INBOUND_SUPPRESSED_CHANNELS.has(msg.channelType)) {
    stateBuffer.seedChannel({
      type: channelIdentity.channel,
      id: channelIdentity.channelId,
      userName: channelIdentity.userName,
    });
  }

  return {
    pipelineStart,
    instanceId,
    conversationId,
    conversationSummary,
    contextPrompt,
    channelIdentity,
    stateBuffer,
    commitGate: msg.commitGate,
    history,
    isFirstTurn,
    summaryFold,
    instanceConfig,
    langsmith,
    userAttachments: msg.attachments,
    isAutoTaskTurn,
    inboundMetadata: Object.keys(msg.metadata).length > 0 ? msg.metadata : undefined,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks — payload + run-context builders
// ---------------------------------------------------------------------------

/**
 * Build the hook event payload, or undefined when hooks must not fire:
 * auto-task turns and turns without a channel identity. Synthetic channels
 * (scheduled/agent) DO run hooks — only auto-tasks are excluded. room/webhook
 * are supervise-direct and wire hooks in their own engines.
 */
export function buildHookPayload(
  ctx: PipelineContext,
  messageText: string,
  responseText?: string,
  regenerationCount = 0,
): HookEventPayload | undefined {
  if (ctx.isAutoTaskTurn || !ctx.channelIdentity) return undefined;
  return {
    instance: { slug: ctx.instanceId },
    conversation: { id: ctx.conversationId },
    channel: { type: ctx.channelIdentity.channel, id: ctx.channelIdentity.channelId },
    user: { name: ctx.channelIdentity.userName ?? "" },
    message: { text: messageText },
    ...(responseText !== undefined ? { response: { text: responseText, regenerationCount } } : {}),
  };
}

/**
 * True if the instance has an ENABLED `response_generated` hook whose function
 * declares `mutatesResponse`. Used by the streaming handler to serve such turns
 * non-streamed (declare-and-buffer) so a post-LLM `replaceResponse` can be
 * applied before any token reaches the client. `getEnabledHooks` takes the slug
 * (it resolves + caches the UUID internally) and swallows unknown slugs → [].
 */
export async function hasResponseMutatingHook(instanceSlug: InstanceSlug): Promise<boolean> {
  const hooks = await getEnabledHooks(instanceSlug, "response_generated").catch(() => []);
  const registry = getHookRegistry();
  return hooks.some(
    (h) => registry.get(h.actionConfig.functionName)?.mutatesResponse === true,
  );
}

function buildHookRunContext(ctx: PipelineContext, abortSignal?: AbortSignal): HookRunContext {
  return {
    instanceId: ctx.instanceId,
    conversationId: ctx.conversationId,
    secrets: ctx.instanceConfig.secrets,
    apiKeys: ctx.instanceConfig.apiKeys,
    provider: ctx.instanceConfig.provider,
    model: ctx.instanceConfig.model,
    flags: {
      memory: ctx.instanceConfig.memoryEnabled,
      knowledge: ctx.instanceConfig.knowledgeEnabled,
      thinking: ctx.instanceConfig.thinkingEnabled,
      debug: ctx.instanceConfig.debugEnabled,
      stateInPrompt: ctx.instanceConfig.stateInPromptEnabled,
      toolResultsInHistory: ctx.instanceConfig.toolResultsInHistoryEnabled,
    },
    state: ctx.stateBuffer?.api(),
    abortSignal,
  };
}

/**
 * Run the `response_generated` hooks for one pass and interpret their outcome.
 * Extracted from runPipelinePost so the replay loop can run it BEFORE persistence.
 * Returns empty summaries when hooks must not fire (auto-task / no channel identity).
 */
export async function runResponseGeneratedHooks(
  ctx: PipelineContext,
  messageText: string,
  responseText: string,
  regenerationCount: number,
  abortSignal?: AbortSignal,
): Promise<ResponseGeneratedOutcome> {
  // Abort-safe: a cancelled run must leave zero side effects. On the buffered replay
  // path this runs INSIDE the generate/evaluate loop, BEFORE runPipelinePost's abort
  // gate — so it is the gate for response_generated hook side effects (state writes,
  // ai.chat, external calls). Once aborted, skip them entirely (they'd fire again on
  // the coordinator's restarted run).
  if (abortSignal?.aborted) return { summaries: [] };
  const payload = buildHookPayload(ctx, messageText, responseText, regenerationCount);
  if (!payload) return { summaries: [] };
  const hookCtx = buildHookRunContext(ctx, abortSignal);
  const summaries = await runHooks("response_generated", payload, hookCtx);
  return { summaries, replace: firstReplaceResponse(summaries), regenerate: firstRegenerate(summaries) };
}

// ---------------------------------------------------------------------------
// After the response — split into:
//   • persistTurn(opts):        awaited; the user and assistant rows, one transaction
//   • afterResponseTail(opts):  in the background; title, summary, memory extraction
//
// The turn is saved before runPipelinePost returns, so before the channel sends
// the reply: a reply that has no matching record is never delivered, and a
// follow-up message always finds the previous exchange in the history.
// ---------------------------------------------------------------------------

export interface AfterResponseOptions {
  conversationId: string;
  instanceId: InstanceSlug;
  userMessage: string;
  assistantResponse: string;
  steps?: StepDetail[];
  /** Aggregated message-level reasoning (Anthropic signed blocks, OpenAI summary). */
  reasoning?: ReasoningDetail[];
  /** Exact LLM request payload — persisted on the assistant row only when DEBUG is on. */
  debugPayload?: LlmDebugPayload;
  /** Pre-generated assistant message UUID (streaming path) — keeps the persisted id stable. */
  assistantMessageId?: string;
  /** User-message attachments to upload + persist alongside the user row. */
  userAttachments?: Attachment[];
  /** Raw inbound metadata (e.g. audio STT block) to persist alongside the user row. */
  inboundMetadata?: Record<string, unknown>;
  /** Set when a hook (not the LLM) authored the reply — persisted as the assistant row's metadata for UI badging. */
  provenance?: HookProvenance;
  /** Message arrival time (pipeline start). Used as the user row's created_at so the
   * commit-on-success write doesn't stamp it at end-of-turn (keeps user < assistant). */
  receivedAt?: Date;
  /** The turn as the model received it; set only for agents that replay their history exactly. */
  exactTurn?: ExactTurn;
}

/**
 * Persist the user message and the reply — with the run's buffered
 * conversation state, when given — in one transaction, and throw when that
 * fails: the caller must then treat the turn as failed and not deliver a
 * reply that the history does not hold. No-op for automated Open WebUI tasks.
 */
export async function persistTurn(opts: AfterResponseOptions, state?: ConversationStateBuffer): Promise<void> {
  if (isAutoTask(opts.userMessage)) return;

  // The user row's id is chosen here when it has attachments to store: they are
  // recorded on it once uploaded, after the turn is saved and delivered.
  const toStore = opts.userAttachments?.some((att) => att.data) ? opts.userAttachments : undefined;
  const userRowId = toStore ? randomUUID() : undefined;

  // Both rows are stamped by this process's clock: the user row at arrival, the
  // reply now. Mixing in the database's clock for one of them would let a skew
  // between the two hosts order the reply before the message it answers.
  await conversationStore.appendMessages(opts.conversationId, [
    {
      ...(userRowId ? { id: userRowId } : {}),
      role: "user",
      content: opts.userMessage,
      metadata: opts.inboundMetadata,
      ...(opts.exactTurn ? { exactReplay: { messages: [toExactUserMessage(opts.exactTurn.user)] } } : {}),
      ...(opts.receivedAt ? { createdAt: opts.receivedAt } : {}),
    },
    {
      // Pre-generated on the streaming path so the client can correlate it with
      // the per-message debug payload, present only when DEBUG was on.
      ...(opts.assistantMessageId ? { id: opts.assistantMessageId } : {}),
      createdAt: new Date(),
      role: "assistant",
      content: opts.assistantResponse,
      steps: opts.steps,
      reasoning: opts.reasoning,
      debugPayload: opts.debugPayload,
      metadata: opts.provenance,
      // A reply a hook wrote is not what the model produced: that row replays
      // compactly, from the text the user received.
      ...(opts.exactTurn && opts.exactTurn.response.length > 0 && !opts.provenance
        ? { exactReplay: { messages: opts.exactTurn.response, prefixKey: opts.exactTurn.prefixKey } }
        : {}),
    },
  ], state ? { inTransaction: (tx) => state.flush(tx) } : undefined);

  if (toStore && userRowId) {
    trackBackgroundTurn(
      storeAttachments(opts, toStore).then(async (stored) => {
        if (stored && !(await conversationStore.setMessageAttachments(opts.conversationId, userRowId, stored))) {
          log.warn("pipeline", `Stored attachments for agent "${opts.instanceId}" found no message to record them on`);
        }
      }).catch((err: unknown) => log.error("pipeline", `Failed to record stored attachments for agent "${opts.instanceId}"`, err)),
    );
  }
}

/**
 * Copy a turn's inbound attachments to the agent's bucket. Runs after the turn
 * is saved and is waited for by shutdown, never by the reply: the S3 client
 * retries for up to minutes, and past the point of no return a turn that waits
 * on it holds the reply and the contact's next messages.
 *
 * No pre-check: `uploadAttachment` answers `null` for an agent with no storage
 * configured, which is the ordinary case. Asking first would read the same
 * secrets twice and give the two reads a chance to disagree. A failed upload
 * (denied bucket policy, wrong region, revoked credentials, a transient S3
 * error) costs that attachment its stored copy, not the turn. Only the error's
 * name is logged — an S3 message carries the object key, and the key carries
 * the conversation id. Undefined when nothing was stored: the column is
 * nullable and an empty array would read as "there were attachments, and none
 * of them are here".
 */
async function storeAttachments(opts: AfterResponseOptions, attachments: Attachment[]): Promise<AttachmentMeta[] | undefined> {
  const results: (AttachmentMeta | null)[] = await Promise.all(
    attachments.map((att) =>
      att.data
        ? uploadAttachment(att.data, {
            type: att.type,
            mimeType: att.mimeType,
            fileName: att.fileName,
            instanceId: opts.instanceId,
            conversationId: opts.conversationId,
          }).catch((err: unknown) => {
            log.warn(
              "pipeline",
              `Attachment upload failed for agent "${opts.instanceId}" (${err instanceof Error ? err.name : "unknown error"}); the turn is saved without it`,
            );
            return null;
          })
        : Promise.resolve(null),
    ),
  );
  const stored = results.filter((r): r is AttachmentMeta => r != null);
  return stored.length > 0 ? stored : undefined;
}

/** What the work after a saved turn needs; see {@link afterResponseTail}. */
export interface TurnTailOptions {
  conversationId: string;
  instanceId: InstanceSlug;
  /** The agent's config: provider, keys, LangSmith, memory switch, timezone. */
  instanceConfig: InstanceConfig;
  /** What the conversation title is generated from, and an optional hint for it. No title without it. */
  titleContent?: string;
  titleContext?: string;
  /** The summary the turn read, which a fold extends. */
  existingSummary?: string;
  /** The oldest messages of the history, to fold into the summary. */
  summaryFold?: SummaryFold;
}

/** Conversations whose summary fold is queued or running in this process. */
const foldsPending = new Set<string>();

/**
 * The work that follows a saved turn and that the next turn does not need:
 * the conversation title, the summary of the messages leaving the window, the
 * memory extraction. Shared by every engine that saves a turn (the pipeline,
 * Room and webhook turns). Title and summary run as one bounded background job,
 * the memory extraction as another in its own queue; shutdown waits for both,
 * failures are logged.
 *
 * One fold per conversation at a time: while one is queued or running, a later
 * turn's fold is dropped, since the one ahead moves the summary and leaves a
 * history short enough again. A fold whose starting point another one has moved
 * meanwhile (another process, or a fold that landed before this turn was
 * saved) is dropped before its model call, which could not land anyway.
 */
export function afterResponseTail(opts: TurnTailOptions): void {
  const cfg = opts.instanceConfig;
  const langsmith = buildLangsmithConfig(cfg);
  const fold = opts.summaryFold && !foldsPending.has(opts.conversationId) ? opts.summaryFold : undefined;
  if (fold) foldsPending.add(opts.conversationId);

  const summarize = async (fold: SummaryFold) => {
    const current = await conversationStore.getSummaryThrough(opts.conversationId);
    if ((current?.getTime() ?? null) !== (fold.previousThrough?.getTime() ?? null)) return;
    const existing = opts.existingSummary
      ? `Previous summary: ${opts.existingSummary}\n\n`
      : "";
    const droppedText = fold.messages
      .map(m => {
        const label = m.role === "user" ? "User" : m.role === "system" ? "System" : "Assistant";
        return `${label}: ${m.content}`;
      })
      .join("\n");
    const datetime = cfg.datetime ?? resolveDatetimeSettings(UNSET_AGENT_SETTINGS);
    const now = new Date().toLocaleString(datetime.locale, {
      timeZone: datetime.timezone,
      dateStyle: "full",
      timeStyle: "short",
    });
    const summaryResponse = await chat({
      tier: "fast",
      provider: cfg.provider,
      apiKeys: cfg.apiKeys,
      langsmith,
      system: `Today's date: ${now}. Summarize the following conversation context in 2-3 concise sentences, in the same language as the conversation. Include key facts, decisions, and context needed to continue the conversation. Preserve exact dates and figures — never paraphrase or approximate timestamps. Respond ONLY with the summary, no other text.`,
      messages: [{
        role: "user",
        content: `${existing}Messages to summarize:\n${droppedText}`,
      }],
    }, { conversationId: opts.conversationId, instanceId: opts.instanceId, callType: "service", purpose: "summary" });

    // Lands only if no other turn moved the summary meanwhile; until it
    // lands, turns keep reading from where the summary reached before.
    const summary = summaryResponse.text.trim();
    if (summary) {
      await conversationStore.advanceSummary(opts.conversationId, summary, fold.through, fold.previousThrough);
    }
  };

  const turnWork = async () => {
    // Generate title (only once, after first exchange)
    if (opts.titleContent !== undefined) {
      await generateConversationTitle({
        conversationId: opts.conversationId,
        instanceId: opts.instanceId,
        provider: cfg.provider,
        apiKeys: cfg.apiKeys,
        langsmith,
        content: opts.titleContent,
        context: opts.titleContext,
      });
    }

    // Fold the oldest messages of the history into the summary, once per block.
    if (fold) {
      await summarize(fold).catch((err: unknown) => log.error("pipeline", "Summary generation failed", err));
    }
  };

  if (opts.titleContent !== undefined || fold) {
    void runBackgroundJob("turn", () =>
      turnWork()
        .catch((err: unknown) => log.error("pipeline", "afterResponseTail error", err))
        .finally(() => {
          if (fold) foldsPending.delete(opts.conversationId);
        }),
    );
  }

  // Automatic memory extraction
  if (cfg.memoryEnabled !== false) {
    void runBackgroundJob("memory", () =>
      extractMemories(opts.conversationId, opts.instanceId, cfg.apiKeys, cfg.provider, langsmith).catch((err) =>
        log.error("pipeline", "Memory extraction failed", err),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// runPipelinePre — context preparation
// ---------------------------------------------------------------------------

export interface PipelinePreResult {
  ctx: PipelineContext;
  contextPrepMs: number;
  /** The message text to use for the supervisor call. */
  messageText: string;
  /** Pre-LLM hook outcomes (conversation_start + message_received). */
  hookExecutions: HookExecutionSummary[];
  /** Set when a pre-LLM hook requested a halt: the LLM call is skipped and this text is the reply.
   *  `persist: false` makes the halted turn ephemeral — see `runPipelinePost`. */
  shortCircuit?: { text: string; persist: boolean };
  /** The agent's MCP servers, read at the start of the turn (`startMcpConnections`). */
  mcpServers: Promise<McpServerRecord[]>;
}

export async function runPipelinePre(
  msg: IncomingMessage,
  conversationIdOverride?: string | null,
  abortSignal?: AbortSignal,
): Promise<PipelinePreResult> {
  // The MCP connections open while the context is read and the pre-LLM hooks
  // run, instead of after them. Only the conversational entry points come here,
  // and they may use oauth servers (see `SupervisorInput.allowOAuth`).
  const mcpServers = startMcpConnections({ instanceSlug: msg.instanceId, allowOAuth: true });

  // Phase 1: Context preparation
  const contextPrepStart = Date.now();
  const ctx = await preparePipeline(msg, conversationIdOverride);
  const contextPrepMs = Date.now() - contextPrepStart;

  // Lifecycle hooks (observe-only, awaited): conversation_start on the first
  // persisted turn, then message_received on every turn — state writes are
  // visible to the supervisor in the same turn. Runs after contextPrepMs is
  // measured so hook latency doesn't pollute the context-prep metric.
  const hookExecutions: HookExecutionSummary[] = [];
  const hookPayload = buildHookPayload(ctx, msg.text);
  if (hookPayload) {
    const hookCtx = buildHookRunContext(ctx, abortSignal);
    if (ctx.isFirstTurn) {
      // A run the coordinator restarted is still the first turn (the cancelled
      // run saved nothing), but its conversation_start hooks already ran: reuse
      // what they produced — injected context, halt, state writes — instead of
      // repeating their external calls.
      const carried = msg.burst?.conversationStart;
      if (carried) {
        hookExecutions.push(...carried.summaries);
        if (carried.state) ctx.stateBuffer?.applyChanges(carried.state);
      } else {
        const summaries = await runHooks("conversation_start", hookPayload, hookCtx);
        hookExecutions.push(...summaries);
        if (msg.burst && !abortSignal?.aborted) {
          msg.burst.conversationStart = { summaries, state: ctx.stateBuffer?.pendingChanges() };
        }
      }
    }
    hookExecutions.push(...(await runHooks("message_received", hookPayload, hookCtx)));
  }

  // A pre-LLM hook may contribute one-shot context to this turn's LLM input.
  // The gateway lifts mid-array `system` messages out of the turns and sends them
  // after the agent's cached system prompt, so they never invalidate it.
  const injected = collectInjectContext(hookExecutions);
  if (injected.length > 0) {
    const sys: ModelMessage[] = injected.map((text) => ({ role: "system", content: text }));
    ctx.history = [...(ctx.history ?? []), ...sys];
  }

  // A pre-LLM hook may request a halt: skip the supervisor and reply with its text.
  const halt = firstHalt(hookExecutions);

  return {
    ctx,
    contextPrepMs,
    messageText: msg.text,
    hookExecutions,
    shortCircuit: halt ? { text: halt.message, persist: halt.persist !== false } : undefined,
    mcpServers,
  };
}

// ---------------------------------------------------------------------------
// runPipelinePost — trace recording + persistence
// ---------------------------------------------------------------------------

export interface PipelinePostOptions {
  ctx: PipelineContext;
  contextPrepMs: number;
  messageText: string;
  channel: string;
  resultText: string;
  steps?: StepDetail[];
  /** Message-level reasoning from supervisor. */
  reasoning?: ReasoningDetail[];
  /** Exact LLM request payload — persisted on the assistant row when DEBUG is on. */
  debugPayload?: LlmDebugPayload;
  /** Pre-generated assistant message UUID (streaming path), so the persisted id matches the one echoed to the client. */
  assistantMessageId?: string;
  toolCallTraces?: ToolCallTrace[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    /** The 5-minute-TTL share of `cacheCreationInputTokens`, when the provider reports a TTL split. */
    cacheCreation5mInputTokens?: number;
  };
  /** Model id used for this turn — persisted per-message on the trace. */
  model?: string;
  /** Provider that served the model. */
  provider?: string;
  /** USD cost split (input/cache/output/total) for this turn. */
  cost?: CostBreakdown;
  /** Whether extended thinking was requested for this turn. */
  thinking?: boolean;
  /** Sampling temperature requested (undefined → provider default). */
  temperature?: number;
  durationMs: number;
  toolBuildingMs: number;
  ttfbMs?: number;
  isStreaming: boolean;
  /** When set and already aborted, skip persistence entirely. */
  abortSignal?: AbortSignal;
  /**
   * When false, skip every persistence side effect for this turn: no latency trace,
   * no conversation-state flush, no `persistTurn`/`afterResponseTail` (messages, summary, memory,
   * debug payload) and no contextPrompt clear. Set by a pre-LLM hook halt carrying
   * `persist: false` — the hook execution is still audited and its telemetry row
   * written, only the turn is ephemeral.
   */
  persist?: boolean;
  /** Set by a caller when the turn's reply was authored by a hook (pre-LLM halt), so it is badged in the UI. */
  provenance?: HookProvenance;
  /** Pre-computed response_generated outcome (buffered replay path). When set,
   *  runPipelinePost does NOT re-run those hooks and does NOT re-apply replace —
   *  the caller already produced the final `resultText`. */
  responseGenerated?: ResponseGeneratedOutcome;
  /** The turn as the model received it (`SupervisorOutput.exactTurn`); persisted only on exact replay. */
  exactTurn?: ExactTurn;
}

export interface PipelinePostResult {
  finalText: string;
  /** Post-LLM hook outcomes: response_generated, plus response_sent on a streamed
   *  turn (on the others those hooks run after this result is returned). */
  hookExecutions: HookExecutionSummary[];
}

export async function runPipelinePost(opts: PipelinePostOptions): Promise<PipelinePostResult> {
  const { ctx } = opts;

  // A hook halt may declare the turn ephemeral (`persist: false`): hooks still run
  // and are audited, but nothing about the turn is written. Absent ⇒ persist.
  const persist = opts.persist !== false;

  // Aborted pipelines leave no trace: skip trace and persistence entirely.
  // The caller (MessageCoordinator) has already discarded the result.
  if (opts.abortSignal?.aborted) {
    return { finalText: opts.resultText, hookExecutions: [] };
  }

  let finalText = opts.resultText;
  const hookExecutions: HookExecutionSummary[] = [];

  // Lifecycle hooks: response_generated precedes outbound delivery on the
  // sync path (the adapter sends only after handleMessage returns) and the
  // state flush below, so hook state writes ride the turn's commit.
  // Streaming caveat: the text has already streamed to the client.
  const hookPayload = buildHookPayload(ctx, opts.messageText, finalText);
  const hookCtx = hookPayload ? buildHookRunContext(ctx, opts.abortSignal) : undefined;

  // Buffered replay path pre-runs response_generated (with the real count) and
  // has already folded any replace into resultText — reuse its summaries, do not
  // re-run or re-apply. Streaming/halt paths run them here (count 0), as before.
  if (opts.responseGenerated) {
    hookExecutions.push(...opts.responseGenerated.summaries);
  } else if (hookPayload && hookCtx) {
    const summaries = await runHooks("response_generated", hookPayload, hookCtx);
    hookExecutions.push(...summaries);
    const replace = firstReplaceResponse(summaries);
    if (replace) finalText = replace.message;
  }
  const provenance = hookProvenance(hookExecutions) ?? opts.provenance;

  // Point of no return, right before the first write. A run that was cancelled
  // meanwhile (a newer fragment arrived while the hooks above were awaited)
  // writes nothing. A run that passes is no longer cancelled: a fragment that
  // arrives while the turn is being saved gets a run of its own, instead of
  // discarding a reply that is already in the history. Without a gate (no
  // coordinator) the abort signal decides, once, here.
  const committed = ctx.commitGate ? ctx.commitGate() : !opts.abortSignal?.aborted;
  if (!committed) {
    return { finalText, hookExecutions };
  }

  const totalMs = Date.now() - ctx.pipelineStart;
  pipelineLog.response(ctx.instanceId, totalMs);

  if (persist) {
    const turn: AfterResponseOptions = {
      conversationId: ctx.conversationId,
      instanceId: ctx.instanceId,
      userMessage: opts.messageText,
      assistantResponse: finalText,
      steps: opts.steps,
      reasoning: opts.reasoning,
      debugPayload: opts.debugPayload,
      assistantMessageId: opts.assistantMessageId,
      // Copied to the agent's bucket only when the agent opted in. The model
      // already had them inline; this decides whether they are kept.
      userAttachments: ctx.instanceConfig.attachmentStorageEnabled ? ctx.userAttachments : undefined,
      inboundMetadata: ctx.inboundMetadata,
      provenance,
      receivedAt: new Date(ctx.pipelineStart),
      exactTurn:
        ctx.instanceConfig.toolResultsInHistoryEnabled && ctx.instanceConfig.toolHistoryReplay === "exact"
          ? opts.exactTurn
          : undefined,
    };
    // The conversation state (commit-on-success) is written in the same
    // transaction as the messages: a tool's derived value is durable before the
    // next turn reads it, and never without the turn that produced it.
    await persistTurn(turn, ctx.stateBuffer);

    if (!isAutoTask(opts.messageText)) {
      const sttFields = extractSttFields(ctx.inboundMetadata);
      const agentCall = ctx.inboundMetadata?.agentCall as AgentCallMetadata | undefined;
      traceStore.record({
        conversationId: ctx.conversationId,
        messageId: opts.assistantMessageId,
        instanceId: ctx.instanceId,
        channel: opts.channel,
        contextPrepMs: opts.contextPrepMs,
        toolBuildingMs: opts.toolBuildingMs,
        llmCallMs: opts.durationMs,
        totalMs,
        ttfbMs: opts.ttfbMs,
        promptTokens: opts.usage.promptTokens,
        completionTokens: opts.usage.completionTokens,
        cachedInputTokens: opts.usage.cachedInputTokens,
        cacheCreationInputTokens: opts.usage.cacheCreationInputTokens,
        cacheCreation5mInputTokens: opts.usage.cacheCreation5mInputTokens,
        model: opts.model,
        provider: opts.provider,
        cost: opts.cost,
        thinking: opts.thinking,
        temperature: opts.temperature,
        toolCalls: opts.toolCallTraces,
        isStreaming: opts.isStreaming,
        parentConversationId: agentCall?.callerConversationId,
        parentTraceId: agentCall?.parentTraceId,
        ...sttFields,
      });

      afterResponseTail({
        conversationId: ctx.conversationId,
        instanceId: ctx.instanceId,
        instanceConfig: ctx.instanceConfig,
        titleContent: `User: ${opts.messageText}\nAssistant: ${finalText}`,
        existingSummary: ctx.conversationSummary,
        summaryFold: ctx.summaryFold,
      });
    }

    // ContextPrompt is one-shot: if we loaded it for this turn, clear it so
    // subsequent inbound turns don't see stale webhook-trigger instructions.
    // Fire-and-forget — errors logged, not propagated.
    if (ctx.contextPrompt) {
      conversationStore.clearContextPrompt(ctx.conversationId).catch((err) =>
        log.error("pipeline", `Failed to clear contextPrompt for ${ctx.conversationId}`, err),
      );
    }
  }

  // Lifecycle hooks: response_sent fires once the turn is finalized and handed
  // to the channel (the pipeline never observes physical delivery — see the
  // hooks design doc). The turn's state is already saved, so persist any state
  // these hooks wrote with a second flush (no-op when nothing changed).
  if (hookPayload && hookCtx) {
    const responseSent = runHooks("response_sent", hookPayload, hookCtx).then(async (summaries) => {
      if (persist && ctx.stateBuffer) {
        try {
          await ctx.stateBuffer.flush();
        } catch (err) {
          log.error("pipeline", `Failed to flush hook state for ${ctx.conversationId}`, err);
        }
      }
      return summaries;
    });
    // A streamed reply has already reached the client: waiting costs no delivery
    // time and brings the outcomes to the client before `done`. Otherwise the
    // channel sends only after this function returns, so the hooks run after
    // it, and the conversation's next turn waits for their state.
    if (opts.isStreaming) hookExecutions.push(...(await responseSent));
    else holdNextTurn(ctx.conversationId, responseSent);
  }

  return { finalText, hookExecutions };
}
