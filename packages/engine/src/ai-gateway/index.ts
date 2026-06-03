// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveModel, estimateCost } from "./config.js";
import { OpenAIProvider, buildOpenAIReasoningOptions } from "./providers/openai.js";
import { AnthropicProvider, buildAnthropicThinkingOptions } from "./providers/anthropic.js";
import { BedrockProvider } from "./providers/bedrock.js";
import { aiLogger } from "./logger.js";
import { buildLangSmithProviderOptions } from "./langsmith.js";
import type { ChatRequest, ChatResponse, ChatStreamResult, ProviderAdapter } from "./types.js";
import { pipelineLog } from "../utils/pipeline-logger.js";
import {
  emitFromChatResponse,
  tapAndForwardFullStream,
  type BusContext,
} from "../activity-stream/bus-emitter.js";
import { findInstanceBySlug } from "../instances/store.js";
import type { InstanceMeta } from "../activity-stream/activity-stream.types.js";

const DEFAULT_PROVIDER = "openai";

const providers: Record<string, ProviderAdapter> = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  bedrock: BedrockProvider,
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
  // The SDK forwards these to the provider; non-thinking-capable models ignore
  // the fields. Anthropic also requires the interleaved beta header which is
  // set unconditionally on the AnthropicProvider factory.
  if (request.thinking) {
    if (providerName === "anthropic") {
      providerOptions = {
        ...providerOptions,
        anthropic: {
          ...(providerOptions?.anthropic ?? {}),
          ...buildAnthropicThinkingOptions(),
        } as Record<string, unknown>,
      };
    } else if (providerName === "openai") {
      providerOptions = {
        ...providerOptions,
        openai: {
          ...(providerOptions?.openai ?? {}),
          ...buildOpenAIReasoningOptions(),
        } as Record<string, unknown>,
      };
    }
  }

  return { provider, providerName, modelId, providerOptions };
}

/** Options shared by chat() and chatStream(). */
export interface ChatCallOptions {
  conversationId?: string;
  instanceId?: string;
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

  const cost = estimateCost(
    config.providerName,
    config.modelId,
    response.usage.promptTokens,
    response.usage.completionTokens
  );

  aiLogger.log(
    aiLogger.createEntry(
      config.providerName,
      config.modelId,
      request.tier,
      request.thinking ?? false,
      response.usage.promptTokens,
      response.usage.completionTokens,
      response.usage.totalTokens,
      cost,
      response.durationMs,
      options?.conversationId,
      options?.instanceId,
      options?.callType,
    )
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

  const response = await config.provider.chat({
    ...request,
    providerOptions: config.providerOptions,
  }, config.modelId);

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

  if (!config.provider.chatStream) {
    throw new Error(`Provider "${config.providerName}" does not support streaming`);
  }

  const stream = await config.provider.chatStream({
    ...request,
    providerOptions: config.providerOptions,
  }, config.modelId);

  const wrappedResponse = stream.response.then((response) => {
    logAndRecordUsage(config, request, response, options);
    return response;
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
      icon: instance.icon ?? null,
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
