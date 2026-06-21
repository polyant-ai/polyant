// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, numeric } from "drizzle-orm/pg-core";

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
