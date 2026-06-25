// SPDX-License-Identifier: AGPL-3.0-or-later

import { Client } from "langsmith";
import * as ai from "ai";
import {
  wrapAISDK,
  createLangSmithProviderOptions,
  convertMessageToTracedFormat,
} from "langsmith/experimental/vercel";

export interface LangSmithConfig {
  apiKey: string;
  project: string;
}

/** Context for grouping traces by conversation/instance. */
export interface TraceContext {
  conversationId?: string;
  agentId?: string;
  /** When "service", thread_id gets a "-service" suffix to separate from conversation traces. */
  callType?: "conversation" | "service";
  /** Provider name (e.g. "openai") — used for ls_provider metadata and cost. */
  providerName?: string;
  /** Resolved model ID (e.g. "gpt-5-mini") — used for ls_model_name metadata and cost. */
  modelId?: string;
  /**
   * Agent-to-agent call metadata. When present, added to the LangSmith trace
   * so the UI can correlate caller and callee runs in the call chain.
   */
  agentCall?: {
    callerSlug: string;
    callerConversationId: string;
    parentTraceId?: string;
    depth: number;
  };
}

/** In-memory cache for LangSmith clients keyed by apiKey. */
const clientCache = new Map<string, Client>();

export function getClient(apiKey: string): Client {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new Client({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

/**
 * Wrap AI SDK functions once at module level via wrapAISDK.
 * When providerOptions.langsmith is absent from a call, no tracing occurs.
 * When present, wrapAISDK creates hierarchical traces with child runs
 * for each LLM call and tool execution within maxSteps.
 */
const wrapped = wrapAISDK(ai);

export const tracedGenerateText = wrapped.generateText;
export const tracedStreamText = wrapped.streamText;

/**
 * Build processOutputs callback that formats output for LangSmith display.
 *
 * Token/cost reporting is intentionally omitted from the parent run —
 * wrapAISDK's middleware already captures tokens on child LLM runs.
 * Reporting on both levels caused double-counting in LangSmith's
 * thread-level aggregation.
 */
function buildProcessOutputs() {
  return async (outputs: { outputs?: Record<string, unknown> }) => {
    try {
      const out = outputs?.outputs;
      if (!out) return outputs;

      // Format output for LangSmith display (mimic wrapAISDK defaults).
      // generateText: steps array available synchronously
      // streamText: content/text may be Promises
      let content: unknown;
      if (Array.isArray(out.steps)) {
        const lastStep = (out.steps as { content?: unknown }[]).at(-1);
        content = lastStep?.content ?? out.text;
      } else {
        content = out.content;
        if (content instanceof Promise) content = await content;
        if (content == null) {
          content = out.text;
          if (content instanceof Promise) content = await content;
        }
      }

      if (content != null && typeof content === "string") {
        return convertMessageToTracedFormat({
          content,
          role: "assistant",
        });
      }
    } catch {
      // Never break tracing if output formatting fails
    }
    return outputs;
  };
}

/**
 * Build providerOptions.langsmith for a single AI SDK call.
 * Sets up tracing with conversation/instance metadata and output formatting.
 * Service calls (title, summary, memory) get a separate thread_id suffix.
 * When LangSmith is not configured, this function should not be called —
 * the gateway skips it, resulting in zero tracing overhead.
 */
export function buildLangSmithProviderOptions(
  config: LangSmithConfig,
  context?: TraceContext,
): Record<string, unknown> {
  const client = getClient(config.apiKey);

  const metadata: Record<string, string> = {};
  if (context?.conversationId) {
    metadata.oa_conversation_id = context.conversationId;
    metadata.thread_id = context.callType === "service"
      ? `${context.conversationId}-service`
      : context.conversationId;
  }
  if (context?.agentId) {
    metadata.agent_id = context.agentId;
  }
  if (context?.agentCall) {
    metadata.caller_slug = context.agentCall.callerSlug;
    metadata.parent_conversation_id = context.agentCall.callerConversationId;
    metadata.agent_call_depth = String(context.agentCall.depth);
    if (context.agentCall.parentTraceId) {
      metadata.parent_trace_id = context.agentCall.parentTraceId;
    }
  }
  // NOTE: ls_provider + ls_model_name intentionally omitted.
  // They trigger LangSmith's internal auto-pricing on child LLM runs,
  // which uses pricing tables that differ from our config.ts.
  // Token/cost tracking is handled by our local ai_logs table instead.

  return createLangSmithProviderOptions({
    client,
    project_name: config.project,
    tracingEnabled: true,
    metadata,
    processOutputs: buildProcessOutputs(),
  });
}
