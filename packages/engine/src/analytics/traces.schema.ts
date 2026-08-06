// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, numeric, real } from "drizzle-orm/pg-core";
import type { CostBreakdown } from "../ai-gateway/types.js";

export interface ToolCallTrace {
  name: string;
  duration_ms: number;
  success: boolean;
}

export const pipelineTraces = pgTable(
  "pipeline_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: text("conversation_id").notNull(),
    messageId: uuid("message_id"),
    instanceId: text("agent_id").notNull(),
    channel: text("channel").notNull(),
    contextPrepMs: integer("context_prep_ms"),
    toolBuildingMs: integer("tool_building_ms"),
    llmCallMs: integer("llm_call_ms"),
    totalMs: integer("total_ms").notNull(),
    ttfbMs: integer("ttfb_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    /** Prompt-cache read/write token counts for this turn (subset of promptTokens). */
    cachedInputTokens: integer("cached_input_tokens"),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    /** Model id actually used for this turn (e.g. "claude-sonnet-5"). */
    model: text("model"),
    /** Provider that served the model (e.g. "anthropic", "openai"). */
    provider: text("provider"),
    /** USD cost split (input/cache/output/total) for this turn. */
    cost: jsonb("cost").$type<CostBreakdown>(),
    /** Whether extended thinking was requested for this turn. */
    thinking: boolean("thinking"),
    /** Sampling temperature requested (null → provider default). */
    temperature: real("temperature"),
    toolCalls: jsonb("tool_calls").$type<ToolCallTrace[]>(),
    isStreaming: boolean("is_streaming").notNull().default(false),
    sttDurationMs: integer("stt_duration_ms"),
    sttProvider: text("stt_provider"),
    audioDurationSec: numeric("audio_duration_sec", { precision: 6, scale: 2 }),
    /** Set when this trace is the child of an agent-to-agent call. Links to the caller's conversationId. */
    parentConversationId: text("parent_conversation_id"),
    /** Set when this trace is the child of an agent-to-agent call. Links to the caller's LangSmith run id. */
    parentTraceId: uuid("parent_trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_traces_instance_created").on(table.instanceId, table.createdAt),
    index("idx_traces_created").on(table.createdAt),
  ],
);
