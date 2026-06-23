// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Pipeline — Extracted shared logic for message handling
// ---------------------------------------------------------------------------
// Houses preparePipeline, afterResponse, runPipelinePre, runPipelinePost,
// and module-level helpers (isAutoTask, isMissingApiKeyError, MISSING_KEY_RESPONSE).
// ---------------------------------------------------------------------------

import type { ModelMessage } from "ai";
import { config, DEFAULT_INSTANCE_ID } from "./config.js";
import type { InstanceSlug } from "./instances/identifiers.js";
import { chat } from "./ai-gateway/index.js";
import { conversationStore } from "./conversations/index.js";
import { ConversationStateBuffer } from "./conversations/state.buffer.js";
import { buildHistoryWithToolResults } from "./conversations/tool-history.js";
import { hookExecutionsToModelMessages, hookExecutionsToSteps } from "./hooks/hook-history.js";
import type { MessageRow } from "./conversations/store.js";
import { extractMemories } from "./memory/index.js";
import { pipelineLog } from "./utils/pipeline-logger.js";
import { generateConversationTitle } from "./utils/title-generator.js";
import { resolveInstanceConfig, type InstanceConfig } from "./instances/config-resolver.js";
import { traceStore } from "./analytics/trace.store.js";
import { uploadAttachment, isPlatformStorageConfigured } from "./attachments/platform-storage.js";
import type { AttachmentMeta, StepDetail, ReasoningDetail, LlmDebugPayload } from "./conversations/schema.js";
import type { AgentCallMetadata, Attachment, IncomingMessage } from "./channels/types.js";
import type { ToolCallTrace } from "./analytics/traces.schema.js";
import { emitInbound } from "./activity-stream/emitters/emit-inbound.js";
import { emitConversation } from "./activity-stream/emitters/emit-conversation.js";
import { resolveInstanceMeta } from "./activity-stream/emit-helpers.js";
import { runHooks } from "./hooks/hook-runner.js";
import type { HookEventPayload, HookExecutionSummary, HookRunContext } from "./hooks/hook-types.js";

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
  "Please go to the admin panel → Instance → Settings tab and set the appropriate API key " +
  "(OpenAI or Anthropic) to enable this assistant.";

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
  history: ModelMessage[] | undefined;
  /** True when no message rows were persisted before this turn (first successful turn). */
  isFirstTurn: boolean;
  hasOverflow: boolean;
  droppedMessages: ModelMessage[] | undefined;
  instanceConfig: InstanceConfig;
  langsmith: { apiKey: string; project: string } | undefined;
  /** Attachments to persist alongside the user message, once the pipeline has succeeded. */
  userAttachments: Attachment[] | undefined;
  /** External system messages to persist alongside the user message. */
  incomingSystemMessages: Array<{ role: string; content: string }> | undefined;
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

export async function preparePipeline(
  msg: IncomingMessage,
  conversationIdOverride?: string | null,
): Promise<PipelineContext> {
  const pipelineStart = Date.now();
  const instanceId: InstanceSlug = msg.instanceId || DEFAULT_INSTANCE_ID;
  pipelineLog.request(msg.channelType, instanceId, msg.text);

  const conversationId = conversationIdOverride
    ?? `${instanceId}:${msg.channelType}:${msg.channelId}`;
  const isAutoTaskTurn = isAutoTask(msg.text);

  // Skip conversation creation for automated tasks (e.g. Open WebUI title/tag generation)
  if (!isAutoTaskTurn) {
    const source = (msg.metadata?.source as string) ?? "user";
    const ensureResult = await conversationStore
      .ensureConversation(conversationId, instanceId, {
        channel: msg.channelType,
        userIdentifier: msg.userName,
        source,
      })
      .catch((err) => {
        console.error(`Failed to ensure conversation ${conversationId}:`, err);
        return { created: false };
      });

    // Activity-stream emit: lifecycle event when a brand-new conversation row
    // is created (never on subsequent turns of the same conversation).
    // Skipped for synthetic channels covered by other emitters.
    if (ensureResult.created && !INBOUND_SUPPRESSED_CHANNELS.has(msg.channelType)) {
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

  // Fetch history, instance config, and context prompt in parallel — all independent.
  const [conversationHistory, instanceConfig, contextPrompt, stateBuffer] = await Promise.all([
    conversationStore.getRecentMessages(conversationId, 16).catch(() => [] as ModelMessage[]),
    resolveInstanceConfig(instanceId),
    conversationStore.getContextPrompt(conversationId).catch(() => null).then((p) => p ?? undefined),
    isAutoTaskTurn
      ? Promise.resolve(undefined)
      : ConversationStateBuffer.load(conversationId, instanceId).catch((err) => {
          console.error(`Failed to load conversation state for ${conversationId}:`, err);
          return new ConversationStateBuffer(conversationId, instanceId);
        }),
  ]);

  // First persisted turn — computed from PERSISTED rows, NOT the metadata
  // fallback below: the OpenAI-compat path passes client-side history that must
  // not suppress the conversation_start hook. Abort-safe by construction: an
  // aborted run persists nothing, so the restarted run still sees zero rows.
  const isFirstTurn = conversationHistory.length === 0;

  // NOTE: user message and incoming system messages are NOT persisted here.
  // They are persisted in `afterResponse()` only after the pipeline succeeds,
  // so that an aborted pipeline (cancel-and-restart) leaves no trace in DB.
  const incomingSystemMessages = (msg.metadata?.systemMessages as Array<{ role: string; content: string }>) ?? [];

  // Sliding window: if >15 messages exist, use summary + last 10; otherwise pass all
  const hasOverflow = conversationHistory.length > 15;
  let history: ModelMessage[] | undefined;
  let conversationSummary: string | undefined;
  let droppedMessages: ModelMessage[] | undefined;

  if (hasOverflow) {
    conversationSummary =
      (await conversationStore.getSummary(conversationId).catch(() => null)) ?? undefined;
    history = conversationHistory.slice(-10);
    droppedMessages = conversationHistory.slice(0, -10);
  } else {
    conversationSummary = undefined;
    history = conversationHistory.length > 0
      ? conversationHistory
      : (msg.metadata?.conversationHistory as ModelMessage[] | undefined);
  }

  // Tool-result replay (opt-in per instance): rebuild the in-window history from
  // raw rows, reconstructing tool_use/tool_result blocks from the persisted
  // `steps` so the model retains tool outputs across turns. Extra fetch only when
  // the flag is on — the default text path above is untouched, and the dropped
  // messages / summary stay text-only.
  if (instanceConfig.toolResultsInHistoryEnabled && !isAutoTaskTurn) {
    const rows = await conversationStore
      .getRecentMessageRows(conversationId, 16)
      .catch(() => [] as MessageRow[]);
    if (rows.length > 0) {
      history = buildHistoryWithToolResults(hasOverflow ? rows.slice(-10) : rows);
    }
  }

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
    history,
    isFirstTurn,
    hasOverflow,
    droppedMessages,
    instanceConfig,
    langsmith,
    userAttachments: msg.attachments,
    incomingSystemMessages: incomingSystemMessages.length > 0 ? incomingSystemMessages : undefined,
    isAutoTaskTurn,
    inboundMetadata: Object.keys(msg.metadata).length > 0 ? msg.metadata : undefined,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks — payload + run-context builders
// ---------------------------------------------------------------------------

/**
 * Build the hook event payload, or undefined when hooks must not fire:
 * auto-task turns and synthetic channels (agent/scheduled/room), consistent
 * with state seeding and inbound emits.
 */
export function buildHookPayload(
  ctx: PipelineContext,
  messageText: string,
  responseText?: string,
): HookEventPayload | undefined {
  if (ctx.isAutoTaskTurn || !ctx.channelIdentity) return undefined;
  if (INBOUND_SUPPRESSED_CHANNELS.has(ctx.channelIdentity.channel)) return undefined;
  return {
    instance: { slug: ctx.instanceId },
    conversation: { id: ctx.conversationId },
    channel: { type: ctx.channelIdentity.channel, id: ctx.channelIdentity.channelId },
    user: { name: ctx.channelIdentity.userName ?? "" },
    message: { text: messageText },
    ...(responseText !== undefined ? { response: { text: responseText } } : {}),
  };
}

function buildHookRunContext(ctx: PipelineContext, abortSignal?: AbortSignal): HookRunContext {
  return {
    instanceId: ctx.instanceId,
    conversationId: ctx.conversationId,
    secrets: ctx.instanceConfig.secrets,
    apiKeys: ctx.instanceConfig.apiKeys,
    provider: ctx.instanceConfig.provider,
    state: ctx.stateBuffer?.api(),
    abortSignal,
  };
}

// ---------------------------------------------------------------------------
// afterResponse — fire-and-forget post-processing (extracted from ~lines 118-200)
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
  existingSummary?: string;
  /** When true, the sliding window overflowed — generate/update summary. */
  needsSummaryUpdate?: boolean;
  /** Messages that fell outside the retained window (to be summarized). */
  droppedMessages?: ModelMessage[];
  memoryEnabled?: boolean;
  provider?: string;
  apiKeys?: InstanceConfig["apiKeys"];
  langsmith?: { apiKey: string; project: string };
  /** User-message attachments to upload + persist alongside the user row. */
  userAttachments?: Attachment[];
  /** External system messages to persist before the user row. */
  incomingSystemMessages?: Array<{ role: string; content: string }>;
  /** Raw inbound metadata (e.g. audio STT block) to persist alongside the user row. */
  inboundMetadata?: Record<string, unknown>;
}

export function afterResponse(opts: AfterResponseOptions): void {
  // Skip automated Open WebUI tasks entirely
  if (isAutoTask(opts.userMessage)) return;

  const work = async () => {
    // 0. Persist external system messages + user message (deferred from pre-pipeline
    // so that an aborted/restarted pipeline leaves no orphan rows in DB).
    // Deduplicate against system messages already in the conversation: clients
    // that replay history (playground, open-webui) re-send the same system block
    // every turn, which would otherwise accumulate one duplicate row per turn
    // (a repeated context card in the UI). Only genuinely new content is written.
    if (opts.incomingSystemMessages?.length) {
      const seen = await conversationStore
        .getSystemMessageContents(opts.conversationId)
        .catch(() => new Set<string>());
      const novel: Array<{ role: string; content: string }> = [];
      for (const sm of opts.incomingSystemMessages) {
        if (seen.has(sm.content)) continue;
        seen.add(sm.content);
        novel.push({ role: "system", content: sm.content });
      }
      if (novel.length > 0) {
        await conversationStore
          .appendMessages(opts.conversationId, novel)
          .catch((err) => console.error(`Failed to persist system messages for ${opts.conversationId}:`, err));
      }
    }

    let attachmentMetas: AttachmentMeta[] | undefined;
    if (opts.userAttachments?.length && isPlatformStorageConfigured()) {
      const results = await Promise.all(
        opts.userAttachments.map((att) =>
          att.data
            ? uploadAttachment(att.data, {
                type: att.type,
                mimeType: att.mimeType,
                fileName: att.fileName,
                instanceId: opts.instanceId,
                conversationId: opts.conversationId,
              })
            : Promise.resolve(null),
        ),
      );
      attachmentMetas = results.filter((r): r is AttachmentMeta => r != null);
    }
    await conversationStore.appendMessages(opts.conversationId, [
      {
        role: "user",
        content: opts.userMessage,
        attachments: attachmentMetas,
        metadata: opts.inboundMetadata,
      },
    ]);

    // 1. Save assistant message to PostgreSQL. The id is pre-generated on the
    // streaming path so the client can correlate it with the per-message debug
    // payload; the debug payload itself is present only when DEBUG was on.
    await conversationStore.appendMessages(opts.conversationId, [
      {
        ...(opts.assistantMessageId ? { id: opts.assistantMessageId } : {}),
        role: "assistant",
        content: opts.assistantResponse,
        steps: opts.steps,
        reasoning: opts.reasoning,
        debugPayload: opts.debugPayload,
      },
    ]);

    // 1.5 Generate title (only once, after first exchange)
    await generateConversationTitle({
      conversationId: opts.conversationId,
      instanceId: opts.instanceId,
      provider: opts.provider,
      apiKeys: opts.apiKeys,
      langsmith: opts.langsmith,
      content: `User: ${opts.userMessage}\nAssistant: ${opts.assistantResponse}`,
    });

    // 2. Update conversation summary (only when sliding window overflows)
    if (opts.needsSummaryUpdate && opts.droppedMessages?.length) {
      const existing = opts.existingSummary
        ? `Previous summary: ${opts.existingSummary}\n\n`
        : "";
      const droppedText = opts.droppedMessages
        .map(m => {
          const label = m.role === "user" ? "User" : m.role === "system" ? "System" : "Assistant";
          return `${label}: ${m.content}`;
        })
        .join("\n");
      try {
        const now = new Date().toLocaleString(config.datetime.locale, {
          timeZone: config.datetime.timezone,
          dateStyle: "full",
          timeStyle: "short",
        });
        const summaryResponse = await chat({
          tier: "fast",
          provider: opts.provider,
          apiKeys: opts.apiKeys,
          langsmith: opts.langsmith,
          system: `Today's date: ${now}. Summarize the following conversation context in 2-3 concise sentences, in the same language as the conversation. Include key facts, decisions, and context needed to continue the conversation. Preserve exact dates and figures — never paraphrase or approximate timestamps. Respond ONLY with the summary, no other text.`,
          messages: [{
            role: "user",
            content: `${existing}Messages to summarize:\n${droppedText}`,
          }],
        }, { conversationId: opts.conversationId, instanceId: opts.instanceId, callType: "service" });

        const summary = summaryResponse.text.trim();
        if (summary) {
          await conversationStore.updateSummary(opts.conversationId, summary);
        }
      } catch (err) {
        console.error("Summary generation failed:", err);
      }
    }

    // 3. Automatic memory extraction (fire-and-forget within fire-and-forget)
    if (opts.memoryEnabled !== false) {
      extractMemories(opts.conversationId, opts.instanceId, opts.apiKeys, opts.provider, opts.langsmith).catch((err) =>
        console.error("Memory extraction failed:", err),
      );
    }
  };

  work().catch((err: unknown) => console.error("afterResponse error:", err));
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
}

export async function runPipelinePre(
  msg: IncomingMessage,
  conversationIdOverride?: string | null,
  abortSignal?: AbortSignal,
): Promise<PipelinePreResult> {
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
      hookExecutions.push(...(await runHooks("conversation_start", hookPayload, hookCtx)));
    }
    hookExecutions.push(...(await runHooks("message_received", hookPayload, hookCtx)));
  }

  // Same-turn visibility (opt-in): a pre-LLM hook's tool call+result is injected into
  // the history sent to the supervisor, so the model sees what the hook's tool returned
  // (e.g. a conversation_start lookup's candidates). Gated by the same flag as the
  // cross-turn replay; no-op when off or when no hook ran a tool.
  if (ctx.instanceConfig.toolResultsInHistoryEnabled) {
    const hookMessages = hookExecutionsToModelMessages(hookExecutions);
    if (hookMessages.length > 0) ctx.history = [...(ctx.history ?? []), ...hookMessages];
  }

  return { ctx, contextPrepMs, messageText: msg.text, hookExecutions };
}

// ---------------------------------------------------------------------------
// runPipelinePost — trace recording + afterResponse
// ---------------------------------------------------------------------------

export interface PipelinePostOptions {
  ctx: PipelineContext;
  contextPrepMs: number;
  messageText: string;
  channel: string;
  resultText: string;
  steps?: StepDetail[];
  /** Pre-LLM hook outcomes (from runPipelinePre): persisted as leading steps when
   *  tool-results-in-history is on, so later turns replay the hook's tool result. */
  preHookExecutions?: HookExecutionSummary[];
  /** Message-level reasoning from supervisor. */
  reasoning?: ReasoningDetail[];
  /** Exact LLM request payload — persisted on the assistant row when DEBUG is on. */
  debugPayload?: LlmDebugPayload;
  /** Pre-generated assistant message UUID (streaming path), so the persisted id matches the one echoed to the client. */
  assistantMessageId?: string;
  toolCallTraces?: ToolCallTrace[];
  usage: { promptTokens: number; completionTokens: number };
  durationMs: number;
  toolBuildingMs: number;
  ttfbMs?: number;
  isStreaming: boolean;
  /** When set and already aborted, skip persistence entirely. */
  abortSignal?: AbortSignal;
}

export interface PipelinePostResult {
  finalText: string;
  /** Post-LLM hook outcomes (response_generated + response_sent). */
  hookExecutions: HookExecutionSummary[];
}

export async function runPipelinePost(opts: PipelinePostOptions): Promise<PipelinePostResult> {
  const { ctx } = opts;

  // Aborted pipelines leave no trace: skip trace/afterResponse entirely.
  // The caller (MessageCoordinator) has already discarded the result.
  if (opts.abortSignal?.aborted) {
    return { finalText: opts.resultText, hookExecutions: [] };
  }

  const finalText = opts.resultText;
  const hookExecutions: HookExecutionSummary[] = [];

  // Lifecycle hooks: response_generated precedes outbound delivery on the
  // sync path (the adapter sends only after handleMessage returns) and the
  // state flush below, so hook state writes ride the turn's commit.
  // Streaming caveat: the text has already streamed to the client.
  const hookPayload = buildHookPayload(ctx, opts.messageText, finalText);
  const hookCtx = hookPayload ? buildHookRunContext(ctx, opts.abortSignal) : undefined;
  if (hookPayload && hookCtx) {
    hookExecutions.push(...(await runHooks("response_generated", hookPayload, hookCtx)));
  }

  const totalMs = Date.now() - ctx.pipelineStart;
  pipelineLog.response(ctx.instanceId, totalMs);

  // Fire-and-forget: record pipeline trace
  if (!isAutoTask(opts.messageText)) {
    const sttFields = extractSttFields(ctx.inboundMetadata);
    const agentCall = ctx.inboundMetadata?.agentCall as AgentCallMetadata | undefined;
    traceStore.record({
      conversationId: ctx.conversationId,
      instanceId: ctx.instanceId,
      channel: opts.channel,
      contextPrepMs: opts.contextPrepMs,
      toolBuildingMs: opts.toolBuildingMs,
      llmCallMs: opts.durationMs,
      totalMs,
      ttfbMs: opts.ttfbMs,
      promptTokens: opts.usage.promptTokens,
      completionTokens: opts.usage.completionTokens,
      toolCalls: opts.toolCallTraces,
      isStreaming: opts.isStreaming,
      parentConversationId: agentCall?.callerConversationId,
      parentTraceId: agentCall?.parentTraceId,
      ...sttFields,
    });
  }

  // Persist conversation state (commit-on-success): reached only when not aborted
  // (the abort gate above already returned). Awaited — a single fast upsert — so a
  // tool's derived value is durable before the next turn reads it.
  if (ctx.stateBuffer) {
    try {
      await ctx.stateBuffer.flush();
    } catch (err) {
      console.error(`Failed to flush conversation state for ${ctx.conversationId}:`, err);
    }
  }

  // Cross-turn replay (opt-in): persist pre-LLM hook tool executions as leading steps
  // on this turn's assistant message, so subsequent turns replay them via
  // buildHistoryWithToolResults. No-op when off or when no hook ran a tool.
  let steps = opts.steps;
  if (ctx.instanceConfig.toolResultsInHistoryEnabled && opts.preHookExecutions?.length) {
    const hookSteps = hookExecutionsToSteps(opts.preHookExecutions);
    if (hookSteps.length > 0) steps = [...hookSteps, ...(opts.steps ?? [])];
  }

  afterResponse({
    conversationId: ctx.conversationId,
    instanceId: ctx.instanceId,
    userMessage: opts.messageText,
    assistantResponse: finalText,
    steps,
    reasoning: opts.reasoning,
    debugPayload: opts.debugPayload,
    assistantMessageId: opts.assistantMessageId,
    existingSummary: ctx.conversationSummary,
    needsSummaryUpdate: ctx.hasOverflow,
    droppedMessages: ctx.droppedMessages,
    memoryEnabled: ctx.instanceConfig.memoryEnabled,
    provider: ctx.instanceConfig.provider,
    apiKeys: ctx.instanceConfig.apiKeys,
    langsmith: ctx.langsmith,
    userAttachments: ctx.userAttachments,
    incomingSystemMessages: ctx.incomingSystemMessages,
    inboundMetadata: ctx.inboundMetadata,
  });

  // ContextPrompt is one-shot: if we loaded it for this turn, clear it so
  // subsequent inbound turns don't see stale webhook-trigger instructions.
  // Fire-and-forget — errors logged, not propagated.
  if (ctx.contextPrompt) {
    conversationStore.clearContextPrompt(ctx.conversationId).catch((err) =>
      console.error(`Failed to clear contextPrompt for ${ctx.conversationId}:`, err),
    );
  }

  // Lifecycle hooks: response_sent fires once the turn is finalized and handed
  // to the channel (the pipeline never observes physical delivery — see the
  // hooks design doc). The main flush already ran, so persist any state these
  // hooks wrote with a second flush (no-op when nothing changed).
  if (hookPayload && hookCtx) {
    hookExecutions.push(...(await runHooks("response_sent", hookPayload, hookCtx)));
    if (ctx.stateBuffer) {
      try {
        await ctx.stateBuffer.flush();
      } catch (err) {
        console.error(`Failed to flush hook state for ${ctx.conversationId}:`, err);
      }
    }
  }

  return { finalText, hookExecutions };
}
