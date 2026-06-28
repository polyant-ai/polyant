// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, integer, real, timestamp, boolean, index } from "drizzle-orm/pg-core";
import type { AILogEntry, ModelTier } from "./types.js";
import { type InstanceSlug } from "../instances/identifiers.js";

export const aiLogs = pgTable(
  "ai_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    tier: text("tier").notNull(),
    thinking: boolean("thinking").notNull().default(false),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    estimatedCostUsd: real("estimated_cost_usd").notNull(),
    durationMs: integer("duration_ms").notNull(),
    reasoningChars: integer("reasoning_chars").notNull().default(0),
    stepCount: integer("step_count").notNull().default(0),
    conversationId: text("conversation_id"),
    instanceId: text("instance_id"),
    callType: text("call_type").notNull().default("conversation"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_ai_logs_instance_id").on(table.instanceId),
    index("idx_ai_logs_created_at").on(table.createdAt),
    index("idx_ai_logs_instance_created").on(table.instanceId, table.createdAt),
    // Conversation-list token/cost LATERAL aggregation filters by conversation_id.
    index("idx_ai_logs_conversation_id").on(table.conversationId),
  ],
);

/** Minimal DB interface for insert operations. */
interface InsertableDb {
  insert(table: unknown): { values(v: unknown): Promise<unknown> };
}

export class AILogger {
  private static readonly MAX_BUFFER_SIZE = 1000;
  private buffer: AILogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private db: InsertableDb | null = null;

  initialize(db: InsertableDb) {
    this.db = db;
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  log(entry: AILogEntry) {
    this.buffer.push(entry);
    if (this.buffer.length >= 10) {
      this.flush();
    }
  }

  async flush() {
    if (this.buffer.length === 0 || !this.db) return;

    const entries = [...this.buffer];
    this.buffer = [];

    try {
      await this.db.insert(aiLogs).values(entries);
    } catch (err) {
      console.error("Failed to flush AI logs:", err);
      // Re-add failed entries, but cap buffer to prevent memory leak
      this.buffer.unshift(...entries);
      if (this.buffer.length > AILogger.MAX_BUFFER_SIZE) {
        const dropped = this.buffer.length - AILogger.MAX_BUFFER_SIZE;
        this.buffer = this.buffer.slice(0, AILogger.MAX_BUFFER_SIZE);
        console.warn(`AILogger: dropped ${dropped} oldest log entries (buffer full)`);
      }
    }
  }

  createEntry(
    provider: string,
    model: string,
    tier: ModelTier,
    thinking: boolean,
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
    estimatedCostUsd: number,
    durationMs: number,
    reasoningChars: number,
    stepCount: number,
    conversationId?: string,
    instanceId?: InstanceSlug,
    callType?: "conversation" | "service",
  ): AILogEntry {
    // Sanitize numeric values — AI SDK may return undefined in some edge cases
    const safeInt = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);
    const safeFloat = (v: number) => (Number.isFinite(v) ? v : 0);
    return {
      provider,
      model,
      tier,
      thinking,
      promptTokens: safeInt(promptTokens),
      completionTokens: safeInt(completionTokens),
      totalTokens: safeInt(totalTokens),
      estimatedCostUsd: safeFloat(estimatedCostUsd),
      durationMs: safeInt(durationMs),
      reasoningChars: safeInt(reasoningChars),
      stepCount: safeInt(stepCount),
      conversationId,
      instanceId,
      callType: callType ?? "conversation",
    };
  }

  async shutdown() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
}

export const aiLogger = new AILogger();
