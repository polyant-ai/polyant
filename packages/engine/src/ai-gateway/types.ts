// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage, Tool } from "ai";
import type { LlmDebugPayload, ReasoningDetail, StepDetail } from "../conversations/schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";

export type ModelTier = "fast" | "standard" | "heavy";

/** Cross-turn prompt-cache TTL (Anthropic). Bedrock is 5m only; OpenAI/Nebius ignore it. */
export type CacheTtl = "5m" | "1h";

export interface ChatRequest {
  tier: ModelTier;
  /** Override the global AI provider for this request. */
  provider?: string;
  /** Override tier-resolved model with a specific model ID. */
  model?: string;
  thinking?: boolean;
  /**
   * Reasoning intensity when `thinking` is on (low|medium|high). Currently
   * consumed only by the Nebius provider (→ `reasoning_effort`); other providers
   * ignore it for now.
   */
  thinkingLevel?: string;
  /** Sampling temperature in [0, 2]. Omitted from the provider call when undefined. */
  temperature?: number;
  messages: ModelMessage[];
  tools?: Record<string, Tool>;
  maxSteps?: number;
  system?: string;
  /** Per-instance API keys. When provided, used instead of process.env defaults. */
  apiKeys?: {
    openai?: string;
    anthropic?: string;
    nebius?: string;
    bedrock_api_key?: string;
    bedrock_access_key_id?: string;
    bedrock_secret_access_key?: string;
    bedrock_region?: string;
  };
  /** Per-instance LangSmith tracing config. */
  langsmith?: { apiKey: string; project: string };
  /** AI SDK provider options (e.g. LangSmith tracing). Built by buildLangSmithProviderOptions(). */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Called in real-time each time a tool is invoked during multi-step execution. */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Cancellation signal propagated to Vercel AI SDK (generateText/streamText). */
  abortSignal?: AbortSignal;
  /**
   * When true, the provider captures the exact request payload (system + messages
   * + tool definitions) and returns it on `ChatResponse.debugPayload`. Gated by the
   * instance `debug_enabled` flag — heavy, opt-in, persisted for analysis/debug.
   */
  captureDebug?: boolean;
  /**
   * Per-instance prompt-cache control. `enabled: false` skips ALL cache markers
   * (Anthropic `cacheControl` / Bedrock `cachePoint`), so the provider never pays
   * a cache write; `ttl` selects the cross-turn Anthropic breakpoint TTL. Undefined
   * = enabled + 1h (backward compatible). No effect on OpenAI (automatic caching,
   * no marker) or Nebius (no cache API).
   */
  cacheConfig?: { enabled: boolean; ttl: CacheTtl };
}

export interface ChatResponse {
  text: string;
  /**
   * Multi-step tool loop. Empty array → no tools were used. Each step records
   * its toolCalls, toolResults, per-step reasoning, finishReason and usage.
   * Replaces the legacy flat `toolCalls?: ToolCallResult[]` field — callers
   * that still need that shape can derive it from `steps.flatMap(s => s.toolCalls)`.
   */
  steps: StepDetail[];
  /**
   * Aggregated reasoning details for this assistant turn (Anthropic signed
   * thinking blocks, OpenAI reasoning summaries). Used both for UI rendering
   * and for re-injecting signed blocks on Anthropic multi-turn flows.
   */
  reasoning?: ReasoningDetail[];
  usage: TokenUsage;
  durationMs: number;
  model: string;
  provider: string;
  /**
   * USD cost of this call, split by pricing bucket. Set by the ai-gateway after
   * the provider returns (from `estimateCostBreakdown`). Threaded up to the
   * pipeline and persisted per-message on `pipeline_traces`.
   */
  cost?: CostBreakdown;
  /** Whether extended thinking was requested for this call (echoed from the request). */
  thinking?: boolean;
  /** Sampling temperature requested for this call (undefined → provider default). */
  temperature?: number;
  /**
   * Exact LLM request payload (system + messages + tool defs) — populated only
   * when `ChatRequest.captureDebug` was set. Threaded up to the pipeline and
   * persisted on the assistant message row (`conversation_messages.debug_payload`).
   */
  debugPayload?: LlmDebugPayload;
}

/**
 * @deprecated Kept for backward-compat shims only. New code reads from
 * `ChatResponse.steps` and uses `StepDetail` from conversations/schema.ts.
 */
export interface ToolCallResult {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Input tokens served from the provider prompt cache (cache HIT). Subset of
   * `promptTokens`. Populated by the ai-gateway on every real call (0 when
   * caching is off/unsupported); optional so lightweight test/util usage
   * literals need not spell it out. Priced at a reduced rate by `estimateCost`.
   */
  cachedInputTokens?: number;
  /**
   * Input tokens written to the provider prompt cache (cache WRITE). Subset of
   * `promptTokens`. Anthropic-only in practice (OpenAI caching is automatic and
   * reports no write). Priced at a premium by `estimateCost`.
   */
  cacheCreationInputTokens?: number;
}

/**
 * USD cost of a single LLM call, split by pricing bucket. `total` is the sum of
 * `input + cache + output` — the same scalar returned by `estimateCost()`.
 */
export interface CostBreakdown {
  input: number;
  cache: number;
  output: number;
  total: number;
}

export interface AILogEntry {
  id?: string;
  provider: string;
  model: string;
  tier: ModelTier;
  thinking: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Input tokens read from the prompt cache (cache HIT). Subset of promptTokens. */
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache (cache WRITE). Subset of promptTokens. */
  cacheCreationInputTokens?: number;
  estimatedCostUsd: number;
  durationMs: number;
  /** Total characters of reasoning/thinking content captured for this call. */
  reasoningChars?: number;
  /** Number of multi-step tool iterations executed by the model loop. */
  stepCount?: number;
  conversationId?: string;
  instanceId?: InstanceSlug;
  callType?: "conversation" | "service";
  createdAt?: Date;
}

/** Result of a streaming chat call */
export interface ChatStreamResult {
  /** Async iterable of text deltas (only final response text) */
  textStream: AsyncIterable<string>;
  /** Async iterable of all stream events (text-delta, tool-call, tool-result, etc.) */
  fullStream: AsyncIterable<unknown>;
  /** Resolves when stream completes with full response data */
  response: Promise<ChatResponse>;
}

export interface ProviderAdapter {
  name: string;
  chat(request: ChatRequest, modelId: string): Promise<ChatResponse>;
  chatStream?(request: ChatRequest, modelId: string): ChatStreamResult | Promise<ChatStreamResult>;
}

export interface TierMapping {
  fast: string;
  standard: string;
  heavy: string;
}
