// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage, Tool } from "ai";
import type { ReasoningDetail, StepDetail } from "../conversations/schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";

export type ModelTier = "fast" | "standard" | "heavy";

export interface ChatRequest {
  tier: ModelTier;
  /** Override the global AI provider for this request. */
  provider?: string;
  /** Override tier-resolved model with a specific model ID. */
  model?: string;
  thinking?: boolean;
  messages: ModelMessage[];
  tools?: Record<string, Tool>;
  maxSteps?: number;
  system?: string;
  /** Per-instance API keys. When provided, used instead of process.env defaults. */
  apiKeys?: {
    openai?: string;
    anthropic?: string;
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
