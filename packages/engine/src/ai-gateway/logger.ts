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
    // Prompt-cache breakdown (subset of prompt_tokens). Lets Analytics show
    // cache hit-rate and real (cache-adjusted) cost. 0 when caching is off.
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    estimatedCostUsd: real("estimated_cost_usd").notNull(),
    durationMs: integer("duration_ms").notNull(),
    reasoningChars: integer("reasoning_chars").notNull().default(0),
    stepCount: integer("step_count").notNull().default(0),
    conversationId: text("conversation_id"),
    instanceId: text("instance_id"),
    callType: text("call_type").notNull().default("conversation"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // A turn that dies at the provider used to leave no row at all. Default 'ok'
    // keeps every historical row meaningful — they are all calls that returned.
    outcome: text("outcome").notNull().default("ok"),
    // The CLASS of the failure (see classifyProviderError below), never the
    // message: the message can quote the request, and the request is the prompt.
    errorKind: text("error_kind"),
  },
  (table) => [
    index("idx_ai_logs_instance_id").on(table.instanceId),
    index("idx_ai_logs_created_at").on(table.createdAt),
    index("idx_ai_logs_instance_created").on(table.instanceId, table.createdAt),
    // Conversation-list token/cost LATERAL aggregation filters by conversation_id.
    index("idx_ai_logs_conversation_id").on(table.conversationId),
    // Error-rate-by-agent queries filter on instance_id + outcome, ordered by time.
    index("idx_ai_logs_instance_outcome").on(table.instanceId, table.outcome, table.createdAt),
  ],
);

/**
 * The CLASS of a provider failure, never its message.
 *
 * The message can quote the request, and the request is the prompt — so what gets
 * stored (and later shown in the panel) is one of a closed set. An unrecognised
 * shape is `unknown`, not the raw text.
 *
 * Verified against the real shape @ai-sdk/provider throws: `APICallError` carries
 * `statusCode` directly on the instance (not nested under a `response` object), so
 * the flat read below is what actually fires for OpenAI/Anthropic/Bedrock/Nebius
 * calls made through this gateway. A bare DOMException from `AbortSignal.timeout()`
 * carries `name === "TimeoutError"` and IS an `instanceof Error` in Node — the
 * second branch covers that shape too.
 */
export function classifyProviderError(err: unknown): string {
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400) return "bad_request";
  if (status === 529 || status === 503) return "overloaded";
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  return "unknown";
}

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
    cachedInputTokens?: number,
    cacheCreationInputTokens?: number,
    outcome: "ok" | "error" = "ok",
    errorKind: string | null = null,
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
      cachedInputTokens: safeInt(cachedInputTokens ?? 0),
      cacheCreationInputTokens: safeInt(cacheCreationInputTokens ?? 0),
      estimatedCostUsd: safeFloat(estimatedCostUsd),
      durationMs: safeInt(durationMs),
      reasoningChars: safeInt(reasoningChars),
      stepCount: safeInt(stepCount),
      conversationId,
      instanceId,
      callType: callType ?? "conversation",
      outcome,
      errorKind,
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
