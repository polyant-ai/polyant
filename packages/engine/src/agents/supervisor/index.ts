// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage, Tool, UserContent } from "ai";
import { tool as aiTool } from "ai";
import type { InstanceSlug, InstanceUuid } from "../../instances/identifiers.js";
import { chat, chatStream, type ChatCallOptions } from "../../ai-gateway/index.js";
import {
  getToolRegistry,
  buildTool,
  normalizeRequiredSecrets,
  type ToolContext,
} from "../tools/registry.js";
import type { Attachment } from "../../channels/types.js";
import { createAuditLogger } from "../../audit/audit-logger.js";
import { auditStore } from "../../audit/audit.store.js";
import { createTaskTool } from "../tools/task-tool.js";
import { buildSupervisorSystemPrompt } from "./prompt.js";
import { pipelineLog } from "../../utils/pipeline-logger.js";
import { config, DEFAULT_INSTANCE_ID } from "../../config.js";
import { getEnabledToolNames } from "../../instances/instance-tools.store.js";
import { findInstanceBySlug } from "../../instances/store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import type { ChatRequest } from "../../ai-gateway/types.js";
import type { LlmDebugPayload, ReasoningDetail, StepDetail } from "../../conversations/schema.js";
import type { ConversationStateBuffer } from "../../conversations/state.buffer.js";
import type { ToolCallTrace } from "../../analytics/traces.schema.js";
import { channelManager } from "../../channels/channel-manager.js";
import type { AgentChannelAdapter } from "../../channels/adapters/agent.adapter.js";
import { buildAgentInvokeTool } from "../tools/agent-invoke.helpers.js";

export interface SupervisorInput {
  message: string;
  conversationHistory?: ModelMessage[];
  instanceId?: InstanceSlug;
  conversationId?: string;
  conversationSummary?: string;
  /** Override AI provider for this instance. */
  provider?: string;
  /** Override model for this instance. */
  model?: string;
  /** Per-instance API keys for AI providers. */
  apiKeys?: ChatRequest["apiKeys"];
  /** Per-instance decrypted secrets (for tools). */
  secrets?: Record<string, string>;
  /** Per-instance LangSmith tracing config. */
  langsmith?: { apiKey: string; project: string };
  /** Whether memory is enabled for this instance. */
  memoryEnabled?: boolean;
  /** Whether knowledge/RAG is enabled for this instance. */
  knowledgeEnabled?: boolean;
  /**
   * Whether to enable extended thinking on the model. Already gated by the
   * config-resolver against the model's actual capability, so the supervisor
   * can forward this verbatim to the AI gateway.
   */
  thinkingEnabled?: boolean;
  /** When true, the current conversation state is rendered read-only into the system prompt. */
  stateInPromptEnabled?: boolean;
  /** Informational opt-out hint to render into the prompt (set when the instance enables it). */
  optoutHint?: { stopKeywords: string[]; resumeKeywords: string[] };
  /** When true, the exact LLM request payload (system + messages + tools) is captured and returned for debug. */
  debugEnabled?: boolean;
  /** Harness categories to include (e.g. "room"). Tools with `harness: true` are only equipped when their category is in this set. */
  includeHarness?: Set<string>;
  /** Attachments from the current user message (images, files, etc.). */
  attachments?: Attachment[];
  /** Additional context prompt from webhook triggers. Injected as system prompt section. */
  contextPrompt?: string;
  /**
   * Identity of the counterpart this conversation is with. When provided, a
   * `## Current channel` section is injected into the system prompt so the
   * agent always knows who it is talking to across channels (inbound or
   * webhook-triggered).
   */
  channelIdentity?: {
    /** Channel type, e.g. "whatsapp", "telegram", "slack", "web". */
    channel: string;
    /**
     * Channel-native identifier: phone in E.164 for WhatsApp, Telegram user/chat id,
     * Slack user id, etc. The agent reasons about it via the prompt.
     */
    channelId: string;
    /** Optional display name/username from the channel. */
    userName?: string;
  };
  /**
   * Current agent-invocation depth. 0 = top-level (human-initiated), 1 = called
   * by another agent. Passed from the `agent` channel adapter via IncomingMessage
   * metadata and threaded to `buildTools` so that synthesised `ask_{slug}` tools
   * can enforce the nesting limit (max depth 1).
   */
  agentCallDepth?: number;
  /**
   * Full agent-call metadata from IncomingMessage.metadata.agentCall.
   * When present, forwarded to the AI gateway so LangSmith can link the
   * child trace back to the caller's trace (best-effort).
   */
  agentCallMetadata?: ChatCallOptions["agentCallMetadata"];
  /** Cancellation signal propagated to the underlying LLM call. */
  abortSignal?: AbortSignal;
  /** Per-run shared conversation state buffer; its `.api()` is exposed to tools as `ctx.state`. */
  stateBuffer?: ConversationStateBuffer;
}

export interface SupervisorOutput {
  text: string;
  /** Per-step multi-step trace from the underlying LLM. Empty array → single-step. */
  steps: StepDetail[];
  /** Aggregated reasoning details (Anthropic signed blocks, OpenAI summaries). */
  reasoning?: ReasoningDetail[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  durationMs: number;
  toolBuildingMs: number;
  toolCallTraces?: ToolCallTrace[];
  ttfbMs?: number;
  /**
   * Set to `true` by a tool whose execution already delivered the outbound reply
   * (e.g. `send_whatsapp_template`). Consumers (webhook-engine, channel handlers)
   * should skip sending `text` as a free-form message when this is true.
   */
  replyHandled?: boolean;
  /**
   * Concatenation of every `replyText` returned by tools in this run. When
   * `replyHandled` is true, this holds the actual content delivered to the
   * user and should be persisted to conversation history in place of `text`
   * (which would otherwise be the supervisor's meta-commentary).
   */
  replyText?: string;
  /**
   * Exact LLM request payload captured when the instance `debug_enabled` flag is
   * on — threaded to the pipeline and persisted on the assistant message row.
   */
  debugPayload?: LlmDebugPayload;
}

/** Shared mutable signals accumulated across tool calls within a single supervise() run. */
interface SupervisorSignals {
  replyHandled: boolean;
  replyTexts: string[];
}

export interface SupervisorStreamOutput {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<unknown>;
  completed: Promise<SupervisorOutput>;
}

/** Safely serialize tool output to a truncated string for audit logs. */
function safeOutputPreview(output: unknown): string | undefined {
  try {
    const raw = JSON.stringify(output);
    if (!raw || raw === "null" || raw === "undefined") return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** Wrap a built tool with audit timing/output capture for the tool phase. */
function wrapToolWithAudit(
  name: string,
  builtTool: Tool,
  instanceId: InstanceSlug,
  _conversationId?: string,
  toolCallTraces?: ToolCallTrace[],
  signals?: SupervisorSignals,
): Tool {
  const original = builtTool as { description?: string; inputSchema: unknown; execute?: (...args: unknown[]) => Promise<unknown> };
  if (!original.execute) return builtTool;

  const originalExecute = original.execute;
  return aiTool({
    description: original.description ?? "",
    inputSchema: original.inputSchema as never,
    execute: async (params: any) => {
      const toolStart = Date.now();

      try {
        const output = await originalExecute(params);
        const durationMs = Date.now() - toolStart;
        const hasError = output != null && typeof output === "object" && "error" in output;
        if (hasError) {
          console.error(`🔧 TOOL ERROR [${name}]`, (output as Record<string, unknown>).error);
        }
        if (signals && output != null && typeof output === "object") {
          const out = output as Record<string, unknown>;
          if (out.replyHandled === true) signals.replyHandled = true;
          if (typeof out.replyText === "string" && out.replyText.length > 0) {
            signals.replyTexts.push(out.replyText);
          }
        }
        toolCallTraces?.push({ name, duration_ms: durationMs, success: !hasError });
        // Backfill duration + output on the audit entry logged by the tool
        auditStore.patchDuration(name, instanceId, durationMs);
        const outputPreview = safeOutputPreview(output);
        if (outputPreview) auditStore.patchOutput(name, instanceId, outputPreview);
        return output;
      } catch (err) {
        const durationMs = Date.now() - toolStart;
        toolCallTraces?.push({ name, duration_ms: durationMs, success: false });
        auditStore.patchDuration(name, instanceId, durationMs);
        throw err;
      }
    },
  });
}

interface BuildToolsOptions {
  instanceId: InstanceSlug;
  instanceUuid: InstanceUuid;
  secrets?: Record<string, string>;
  memoryEnabled?: boolean;
  knowledgeEnabled?: boolean;
  apiKeys?: ChatRequest["apiKeys"];
  provider?: string;
  conversationId?: string;
  toolCallTraces?: ToolCallTrace[];
  includeHarness?: Set<string>;
  attachments?: Attachment[];
  signals?: SupervisorSignals;
  /** Current agent invocation depth (0 = top-level). Used when synthesising `ask_{slug}` tools. */
  agentCallDepth?: number;
  /** Per-run shared conversation state buffer; its `.api()` becomes `ctx.state`. */
  stateBuffer?: ConversationStateBuffer;
}

/** Build the tool set scoped to an instance, filtered by DB-stored enabled tool names. */
async function buildTools(opts: BuildToolsOptions) {
  const { instanceId, instanceUuid, secrets, memoryEnabled, knowledgeEnabled, apiKeys, provider, conversationId, toolCallTraces, includeHarness, attachments, signals, agentCallDepth, stateBuffer } = opts;
  const enabledNames = await getEnabledToolNames(instanceUuid);
  const allEnabled = enabledNames.size === 0; // empty = no rows, enable all (backward compat)

  const tools: Record<string, Tool> = {};
  for (const [name, def] of getToolRegistry()) {
    if (def.metaTool) continue; // Meta-tools are built separately below
    // Harness tools bypass instance_tools enablement — they are injected by the engine when includeHarness matches
    const isHarnessIncluded = def.harness && includeHarness?.has(def.category ?? "general");
    if (isHarnessIncluded || allEnabled || enabledNames.has(name)) {
      // Skip memory-category tools when memory is disabled for this instance
      if (memoryEnabled === false && def.category === "memory") continue;
      // Skip knowledge-category tools when knowledge is disabled for this instance
      if (knowledgeEnabled === false && def.category === "knowledge") continue;
      // Skip harness tools unless their category is explicitly included
      if (def.harness && !isHarnessIncluded) continue;
      // Check requiredSecrets: skip tools whose non-optional secret keys are not configured.
      // Optional specs (e.g. provider-conditional API keys) are ignored here — the tool
      // itself returns an explicit error at runtime if the chosen branch is misconfigured.
      if (def.requiredSecrets?.length) {
        const requiredKeys = normalizeRequiredSecrets(def.requiredSecrets)
          .filter((s) => !s.optional)
          .map((s) => s.key);
        const missing = requiredKeys.filter((k) => !secrets?.[k]);
        if (missing.length > 0) continue;
      }
      const ctx: ToolContext = {
        instanceId,
        secrets,
        audit: createAuditLogger(name, instanceId, conversationId),
        conversationId,
        attachments,
        apiKeys,
        provider,
        state: stateBuffer?.api(),
      };
      const built = buildTool(def, ctx);
      tools[name] = wrapToolWithAudit(name, built, instanceId, conversationId, toolCallTraces, signals);
    }
  }

  // --- agent-to-agent invocation: synthesise a tool per "agent:<targetSlug>" entry ---
  // The catalog row is managed by agent-tool-sync when the callee enables/disables
  // its `agent` channel; here we look up the target instance + its running
  // AgentChannelAdapter and wrap a `buildAgentInvokeTool` into an aiTool.
  const agentEntries = [...enabledNames].filter((n) => n.startsWith("agent:"));
  if (agentEntries.length > 0) {
    const currentDepth = agentCallDepth ?? 0;
    for (const entryName of agentEntries) {
      const targetSlug = entryName.slice("agent:".length);
      const target = await findInstanceBySlug(asInstanceSlug(targetSlug));
      if (!target) {
        console.warn(`[supervisor] agent tool '${entryName}': target instance not found`);
        continue;
      }
      const adapter = channelManager.getAdapter(target.slug, "agent") as AgentChannelAdapter | undefined;
      if (!adapter) {
        console.warn(`[supervisor] agent tool '${entryName}': target has 'agent' channel disabled`);
        continue;
      }
      const synth = buildAgentInvokeTool({
        target: {
          id: target.id,
          slug: target.slug,
          name: target.name,
          description: target.description,
        },
        callerSlug: instanceId,
        callerConversationId: conversationId ?? `${instanceId}:unknown`,
        parentTraceId: undefined,
        currentDepth,
        timeoutMs: config.agent.callTimeoutMs,
        dispatch: (input) => adapter.dispatch(input),
      });
      tools[synth.name] = aiTool({
        description: synth.description,
        inputSchema: synth.inputSchema,
        execute: synth.execute as (args: { prompt: string }) => Promise<string>,
      });
    }
  }

  // spawnTask: meta-tool built last so the sub-agent's tool set is a
  // point-in-time snapshot of everything else (including ask_* handoffs).
  // Passing `{ ...tools }` ensures the sub-agent cannot see spawnTask
  // inserted on the next line — the factory itself also strips spawnTask
  // defensively (no self-recursion).
  if (allEnabled || enabledNames.has("spawnTask")) {
    const spawnTool = createTaskTool({ ...tools }, apiKeys, instanceId, conversationId);
    tools.spawnTask = wrapToolWithAudit("spawnTask", spawnTool, instanceId, conversationId, toolCallTraces, signals);
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

interface SupervisorContext {
  instanceId: InstanceSlug;
  tools: Record<string, Tool>;
  systemPrompt: string;
  messages: ModelMessage[];
  toolBuildingMs: number;
  toolCallTraces: ToolCallTrace[];
  signals: SupervisorSignals;
}

/**
 * Build user message content — multimodal (array) when attachments are present,
 * plain string otherwise (backward compatible).
 */
function buildUserContent(message: string, attachments?: Attachment[]): string | UserContent {
  if (!attachments?.length) return message;

  const parts: UserContent = [{ type: "text", text: message }];

  for (const att of attachments) {
    if (!att.data) continue;
    const isImage = att.type === "image" || att.mimeType?.startsWith("image/");
    if (isImage) {
      parts.push({ type: "image" as const, image: att.data, mediaType: att.mimeType });
    } else {
      parts.push({
        type: "file" as const,
        data: att.data,
        mediaType: att.mimeType ?? "application/octet-stream",
      });
    }
  }

  return parts;
}

async function prepareSupervisor(input: SupervisorInput): Promise<SupervisorContext> {
  const instanceSlug = input.instanceId ?? DEFAULT_INSTANCE_ID;

  // Resolve slug → UUID for DB queries
  const instance = await findInstanceBySlug(instanceSlug);
  if (!instance) {
    throw new Error(`Instance not found: "${instanceSlug}"`);
  }
  const instanceUuid = instance.id;

  const toolCallTraces: ToolCallTrace[] = [];
  const signals: SupervisorSignals = { replyHandled: false, replyTexts: [] };
  const toolBuildStart = Date.now();
  const tools = await buildTools({
    instanceId: instanceSlug,
    instanceUuid,
    secrets: input.secrets,
    memoryEnabled: input.memoryEnabled,
    knowledgeEnabled: input.knowledgeEnabled,
    apiKeys: input.apiKeys,
    provider: input.provider,
    conversationId: input.conversationId,
    toolCallTraces,
    includeHarness: input.includeHarness,
    attachments: input.attachments,
    signals,
    agentCallDepth: input.agentCallDepth,
    stateBuffer: input.stateBuffer,
  });
  const toolBuildingMs = Date.now() - toolBuildStart;

  const systemPrompt = await buildSupervisorSystemPrompt({
    tools,
    instanceId: instanceUuid,
    instanceSlug,
    memoryEnabled: input.memoryEnabled,
    conversationSummary: input.conversationSummary,
    contextPrompt: input.contextPrompt,
    channelIdentity: input.channelIdentity,
    conversationState: input.stateInPromptEnabled ? input.stateBuffer?.snapshot() : undefined,
    optoutHint: input.optoutHint,
  });

  pipelineLog.systemPrompt(instanceSlug, systemPrompt);
  pipelineLog.supervisorStart(instanceSlug, Object.keys(tools).length);

  // Build user message — multimodal when attachments are present
  const userContent = buildUserContent(input.message, input.attachments);
  const messages: ModelMessage[] = [
    ...(input.conversationHistory ?? []),
    { role: "user", content: userContent },
  ];

  return { instanceId: instanceSlug, tools, systemPrompt, messages, toolBuildingMs, toolCallTraces, signals };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function superviseStream(input: SupervisorInput): Promise<SupervisorStreamOutput> {
  const ctx = await prepareSupervisor(input);

  const stream = await chatStream(
    {
      tier: "standard",
      provider: input.provider,
      model: input.model,
      thinking: input.thinkingEnabled ?? false,
      apiKeys: input.apiKeys,
      langsmith: input.langsmith,
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools: ctx.tools,
      maxSteps: 15,
      abortSignal: input.abortSignal,
      captureDebug: input.debugEnabled ?? false,
    },
    {
      conversationId: input.conversationId,
      instanceId: ctx.instanceId,
      agentCallMetadata: input.agentCallMetadata,
    }
  );

  // Wrap textStream to capture TTFB (time to first token)
  let ttfbMs: number | undefined;
  const streamStart = Date.now();
  const ttfbTextStream = (async function* () {
    for await (const chunk of stream.textStream) {
      if (ttfbMs === undefined) ttfbMs = Date.now() - streamStart;
      yield chunk;
    }
  })();

  return {
    textStream: ttfbTextStream,
    fullStream: stream.fullStream,
    completed: stream.response.then((response) => {
      pipelineLog.supervisorDone(ctx.instanceId, response.durationMs, response.text);
      return {
        text: response.text,
        steps: response.steps,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        usage: response.usage,
        durationMs: response.durationMs,
        toolBuildingMs: ctx.toolBuildingMs,
        toolCallTraces: ctx.toolCallTraces.length > 0 ? ctx.toolCallTraces : undefined,
        ttfbMs,
        replyHandled: ctx.signals.replyHandled || undefined,
        replyText: ctx.signals.replyTexts.length > 0 ? ctx.signals.replyTexts.join("\n\n") : undefined,
        ...(response.debugPayload ? { debugPayload: response.debugPayload } : {}),
      };
    }),
  };
}

export async function supervise(input: SupervisorInput): Promise<SupervisorOutput> {
  const ctx = await prepareSupervisor(input);

  const response = await chat(
    {
      tier: "standard",
      provider: input.provider,
      model: input.model,
      thinking: input.thinkingEnabled ?? false,
      apiKeys: input.apiKeys,
      langsmith: input.langsmith,
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools: ctx.tools,
      maxSteps: 15,
      abortSignal: input.abortSignal,
      captureDebug: input.debugEnabled ?? false,
    },
    {
      conversationId: input.conversationId,
      instanceId: ctx.instanceId,
      agentCallMetadata: input.agentCallMetadata,
    }
  );

  pipelineLog.supervisorDone(ctx.instanceId, response.durationMs, response.text);

  return {
    text: response.text,
    steps: response.steps,
    ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    usage: response.usage,
    durationMs: response.durationMs,
    toolBuildingMs: ctx.toolBuildingMs,
    toolCallTraces: ctx.toolCallTraces.length > 0 ? ctx.toolCallTraces : undefined,
    replyHandled: ctx.signals.replyHandled || undefined,
    replyText: ctx.signals.replyTexts.length > 0 ? ctx.signals.replyTexts.join("\n\n") : undefined,
    ...(response.debugPayload ? { debugPayload: response.debugPayload } : {}),
  };
}
