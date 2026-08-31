// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveModel, estimateCostBreakdown, isThinkingCapable, isReasoningAlwaysOn, reasoningControlFor, resolveReasoningLevel } from "./config.js";
import { sanitizeMessagesForModel } from "./vision.js";
import { OpenAIProvider, buildOpenAIReasoningOptions } from "./providers/openai.js";
import { AnthropicProvider, buildAnthropicThinkingOptions } from "./providers/anthropic.js";
import { BedrockProvider, buildBedrockReasoningOptions } from "./providers/bedrock.js";
import { NebiusProvider } from "./providers/nebius.js";
import { aiLogger, classifyProviderError } from "./logger.js";
import { buildLangSmithProviderOptions } from "./langsmith.js";
import type { ChatRequest, ChatResponse, ChatStreamResult, ProviderAdapter } from "./types.js";
import { pipelineLog } from "../utils/pipeline-logger.js";
import {
  emitFromChatResponse,
  tapAndForwardFullStream,
  type BusContext,
} from "../activity-stream/bus-emitter.js";
import { findInstanceBySlug } from "../instances/store.js";
import { buildInstanceIconUrl } from "../instances/icon-url.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import type { InstanceMeta } from "../activity-stream/activity-stream.types.js";

const DEFAULT_PROVIDER = "openai";

const providers: Record<string, ProviderAdapter> = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  bedrock: BedrockProvider,
  nebius: NebiusProvider,
};

let initialized = false;

export function initAIGateway(db?: unknown) {
  if (initialized) return;

  aiLogger.initialize(db as Parameters<typeof aiLogger.initialize>[0]);
  initialized = true;

  console.log("AI Gateway initialized");
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

interface CallConfig {
  provider: ProviderAdapter;
  providerName: string;
  modelId: string;
  providerOptions: Record<string, Record<string, unknown>> | undefined;
}

function resolveCallConfig(
  request: ChatRequest,
  options?: ChatCallOptions,
): CallConfig {
  const providerName = request.provider ?? DEFAULT_PROVIDER;
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider "${providerName}" not configured`);
  }

  const modelId = request.model ?? resolveModel(providerName, request.tier);

  pipelineLog.llmCall(options?.instanceId ?? "", request.tier, modelId, !!request.tools);

  // Build LangSmith providerOptions when tracing is enabled
  let providerOptions = request.providerOptions;
  if (request.langsmith) {
    const lsOptions = buildLangSmithProviderOptions(request.langsmith, {
      conversationId: options?.conversationId,
      instanceId: options?.instanceId,
      callType: options?.callType,
      providerName,
      modelId,
      agentCall: options?.agentCallMetadata,
    });
    providerOptions = { ...providerOptions, langsmith: lsOptions as Record<string, unknown> };
  }

  // Inject provider-specific thinking/reasoning configuration when requested.
  // Gated on isThinkingCapable for ALL providers (defense-in-depth): config-
  // resolver already clears a stale `thinking=true` for a non-capable model, but
  // gating here too guarantees the ai-gateway boundary never sends thinking
  // config to a model that would ignore it (OpenAI/Anthropic) or hard-reject it
  // (Bedrock's ValidationException, like the cachePoint). Anthropic also needs
  // the interleaved beta header, set unconditionally on the AnthropicProvider
  // factory. Shape is mapped per family in the build* helpers via the catalog's
  // reasoningControl (adaptive+effort / budget / effort).
  // Clamp the requested level to what THIS model accepts (per the catalog's
  // live-verified reasoningLevels) — a stale/out-of-range effort (e.g. xhigh on o3,
  // max on gpt-oss) would otherwise 400. Falls back to "medium" (universally valid).
  const thinkingLevel = resolveReasoningLevel(providerName, modelId, request.thinkingLevel ?? "medium");
  if (request.thinking && isThinkingCapable(providerName, modelId)) {
    if (providerName === "anthropic") {
      providerOptions = {
        ...providerOptions,
        anthropic: {
          ...(providerOptions?.anthropic ?? {}),
          ...buildAnthropicThinkingOptions(thinkingLevel, reasoningControlFor(providerName, modelId) === "adaptive"),
        } as Record<string, unknown>,
      };
    } else if (providerName === "openai") {
      providerOptions = {
        ...providerOptions,
        openai: {
          ...(providerOptions?.openai ?? {}),
          ...buildOpenAIReasoningOptions(thinkingLevel),
        } as Record<string, unknown>,
      };
    } else if (providerName === "bedrock") {
      providerOptions = {
        ...providerOptions,
        bedrock: {
          ...(providerOptions?.bedrock ?? {}),
          ...buildBedrockReasoningOptions(thinkingLevel, reasoningControlFor(providerName, modelId) ?? "budget"),
        } as Record<string, unknown>,
      };
    }
  }

  // Nebius (OpenAI-compatible): reasoning models (Qwen3.5 hybrid & friends) think
  // BY DEFAULT, and `reasoning_effort` only tunes intensity — it does NOT turn
  // thinking off. The real off-switch is the vLLM chat-template kwarg
  // `enable_thinking:false`, which @ai-sdk/openai-compatible forwards verbatim into
  // the request body. Drive BOTH states so the admin `thinking` toggle actually
  // controls the model (without it, "off" left the model reasoning by default).
  // Gated on isThinkingCapable so the Qwen-specific kwarg never reaches a
  // non-reasoning model. EXCEPTION: gpt-oss (isReasoningAlwaysOn) reasons on
  // every call and IGNORES enable_thinking (that kwarg is Qwen-only), so its
  // "off" must send nothing — it falls back to its own reasoning default. There
  // is no off; the frontend disables the toggle for these models accordingly.
  if (providerName === "nebius" && isThinkingCapable(providerName, modelId)) {
    providerOptions = {
      ...providerOptions,
      nebius: {
        ...(providerOptions?.nebius ?? {}),
        ...(request.thinking
          ? { reasoningEffort: resolveReasoningLevel(providerName, modelId, request.thinkingLevel ?? "medium") }
          : isReasoningAlwaysOn(modelId)
            ? {}
            : { chat_template_kwargs: { enable_thinking: false } }),
      } as Record<string, unknown>,
    };
  }

  // v6: OpenAI's `strictJsonSchema` defaults to true; our tools use Zod
  // .nullish()/.optional() schemas (incompatible with strict mode). v4 disabled
  // this via the now-removed factory option `structuredOutputs:false` — we opt
  // out per call here so non-strict tool schemas keep validating.
  if (providerName === "openai") {
    providerOptions = {
      ...providerOptions,
      openai: {
        ...(providerOptions?.openai ?? {}),
        strictJsonSchema: false,
      } as Record<string, unknown>,
    };
  }

  return { provider, providerName, modelId, providerOptions };
}

/** Options shared by chat() and chatStream(). */
export interface ChatCallOptions {
  conversationId?: string;
  instanceId?: InstanceSlug;
  callType?: "conversation" | "service";
  /**
   * Agent-to-agent call metadata forwarded from IncomingMessage.metadata.agentCall.
   * When present, enriches the LangSmith trace with caller identity so the UI
   * can display the parent→child call chain.
   */
  agentCallMetadata?: {
    callerSlug: string;
    callerConversationId: string;
    parentTraceId?: string;
    depth: number;
  };
}

/** Total reasoning content size, in characters, for analytics. */
function reasoningCharCount(response: ChatResponse): number {
  if (!response.reasoning) return 0;
  let n = 0;
  for (const r of response.reasoning) {
    if (r.type === "text") n += r.text.length;
    else if (r.type === "redacted") n += r.data.length;
  }
  return n;
}

function logAndRecordUsage(
  config: { providerName: string; modelId: string },
  request: ChatRequest,
  response: ChatResponse,
  options?: ChatCallOptions,
): void {
  pipelineLog.llmResponse(
    options?.instanceId ?? "",
    config.modelId,
    { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
    response.durationMs,
    response.steps?.reduce((acc, s) => acc + s.toolCalls.length, 0) ?? 0,
  );

  const cost = estimateCostBreakdown(
    config.providerName,
    config.modelId,
    response.usage.promptTokens,
    response.usage.completionTokens,
    {
      cachedInputTokens: response.usage.cachedInputTokens,
      cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
    },
  );
  // Propagate the split up to the pipeline (persisted per-message on pipeline_traces).
  response.cost = cost;
  // Echo the requested thinking / temperature so the pipeline can persist them
  // per-message for debug/analysis.
  response.thinking = request.thinking ?? false;
  response.temperature = request.temperature;

  aiLogger.log(
    aiLogger.createEntry(
      config.providerName,
      config.modelId,
      request.tier,
      request.thinking ?? false,
      response.usage.promptTokens,
      response.usage.completionTokens,
      response.usage.totalTokens,
      cost.total,
      response.durationMs,
      reasoningCharCount(response),
      response.steps.length,
      options?.conversationId,
      options?.instanceId,
      options?.callType,
      response.usage.cachedInputTokens,
      response.usage.cacheCreationInputTokens,
    )
  );
}

/**
 * A turn that dies at the provider used to leave no row at all — "this agent
 * is erroring" was not a question ai_logs could answer. Logged with zeroed
 * usage/cost (there is none, the call never returned) and the error's CLASS
 * only, never its message — the message can quote the request, and the
 * request is the prompt.
 *
 * Skips logging entirely when `request.abortSignal` is already aborted: that
 * abort is the message coordinator preempting an in-flight turn because a
 * follow-up message arrived (`message-coordinator.ts`'s cancel-and-restart),
 * not the provider failing. It is the routine path, not a fault — it happens
 * every time a user sends a second message before the first reply lands.
 * Counting every preempted turn as an error would make a later failure RATE
 * mostly measure how often people type quickly. An aborted turn writes nothing
 * at all here — it is not a success either, so no third `outcome` value is
 * invented for it.
 */
function logFailedCall(
  config: { providerName: string; modelId: string },
  request: ChatRequest,
  err: unknown,
  options: ChatCallOptions | undefined,
  durationMs: number,
): void {
  if (request.abortSignal?.aborted) return;

  aiLogger.log(
    aiLogger.createEntry(
      config.providerName,
      config.modelId,
      request.tier,
      request.thinking ?? false,
      0,
      0,
      0,
      0,
      durationMs,
      0,
      0,
      options?.conversationId,
      options?.instanceId,
      options?.callType,
      0,
      0,
      "error",
      classifyProviderError(err),
    ),
  );
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function chat(
  request: ChatRequest,
  options?: ChatCallOptions,
): Promise<ChatResponse> {
  const config = resolveCallConfig(request, options);
  const callStartedAt = Date.now();

  let response: ChatResponse;
  try {
    response = await config.provider.chat({
      ...request,
      messages: sanitizeMessagesForModel(request.messages, config.modelId),
      providerOptions: config.providerOptions,
    }, config.modelId);
  } catch (err) {
    // Exactly one row per failed call: this is the only place chat() invokes
    // the provider, and a thrown error here skips the success log below
    // entirely (no retry loop wraps this — a caller that retries makes a new
    // chat() call, which is correctly a new event).
    logFailedCall(config, request, err, options, Date.now() - callStartedAt);
    throw err;
  }

  logAndRecordUsage(config, request, response, options);

  // Replay the response steps onto the ActivityBus as a one-shot batch so
  // non-streaming callers (room-engine, webhook-engine, scheduled-tasks)
  // still feed the live activity panel. Fire-and-forget — failures are
  // swallowed by the bus emitter to keep the chat path unaffected.
  //
  // Skip the emit for:
  //   - service-type calls (summary, title, memory extraction, webhook
  //     matcher, internal tool sub-LLMs): they're internals, not part of
  //     the visible turn and would surface as duplicate REPLY/tool events.
  //   - aborted pipelines (cancel-and-restart on the message coordinator):
  //     the cancelled run shouldn't leave events behind for the user.
  if (options?.callType !== "service" && !request.abortSignal?.aborted) {
    void buildBusContext(options).then((ctx) => emitFromChatResponse(response, ctx)).catch(() => undefined);
  }

  return response;
}

export async function chatStream(
  request: ChatRequest,
  options?: ChatCallOptions,
): Promise<ChatStreamResult> {
  const config = resolveCallConfig(request, options);
  const callStartedAt = Date.now();

  if (!config.provider.chatStream) {
    throw new Error(`Provider "${config.providerName}" does not support streaming`);
  }

  let stream: ChatStreamResult;
  try {
    stream = await config.provider.chatStream({
      ...request,
      messages: sanitizeMessagesForModel(request.messages, config.modelId),
      providerOptions: config.providerOptions,
    }, config.modelId);
  } catch (err) {
    // Same exactly-once reasoning as chat(): the request-time failure (before
    // any stream is established) is the only provider call chatStream() makes.
    logFailedCall(config, request, err, options, Date.now() - callStartedAt);
    throw err;
  }

  // stream.response settles ONCE (it is a single promise handed back to the
  // caller), so success (.then) and mid-stream failure (.catch) are mutually
  // exclusive — never both, so still exactly one row for this call.
  const wrappedResponse = stream.response
    .then((response) => {
      logAndRecordUsage(config, request, response, options);
      return response;
    })
    .catch((err) => {
      logFailedCall(config, request, err, options, Date.now() - callStartedAt);
      throw err;
    });

  // Tap the fullStream so live tool-call / reasoning / step-finish events
  // flow onto the ActivityBus while the original consumer still receives
  // every chunk unchanged. The instance metadata is fetched once per call
  // (small, cached upstream by ttl-cache via findInstanceBySlug).
  //
  // Service-type calls bypass the tap entirely (same rationale as `chat()`):
  // an internal LLM invocation must not pollute the visible turn timeline.
  const skipBus = options?.callType === "service";
  const busCtxPromise = skipBus ? null : buildBusContext(options);
  const tappedFullStream = (async function* tapped() {
    if (skipBus || busCtxPromise === null) {
      yield* stream.fullStream as AsyncIterable<unknown>;
      return;
    }
    const ctx = await busCtxPromise;
    yield* tapAndForwardFullStream(stream.fullStream, ctx) as AsyncIterable<unknown>;
  })();

  return { textStream: stream.textStream, fullStream: tappedFullStream, response: wrappedResponse };
}

async function buildBusContext(options?: ChatCallOptions): Promise<BusContext> {
  if (!options?.instanceId) {
    return { conversationId: options?.conversationId };
  }
  // Fetch is cheap (it's a single index lookup) and we only do it once per
  // chat() / chatStream() call. Failures degrade gracefully to a context
  // without instance metadata — the event is still emitted.
  try {
    const instance = await findInstanceBySlug(options.instanceId);
    if (!instance) {
      return { conversationId: options.conversationId };
    }
    const meta: InstanceMeta = {
      id: instance.id,
      slug: instance.slug,
      name: instance.name,
      // Emit a URL, never the raw base64 data URI — see buildInstanceIconUrl.
      icon: buildInstanceIconUrl(instance.slug, instance.icon, instance.updatedAt),
    };
    return { instance: meta, conversationId: options.conversationId };
  } catch {
    return { conversationId: options.conversationId };
  }
}

export async function shutdown() {
  await aiLogger.shutdown();
}

export type { ChatRequest, ChatResponse, ChatStreamResult, ModelTier } from "./types.js";
