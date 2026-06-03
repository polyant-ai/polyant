// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, desc, asc, sql, count, inArray } from "drizzle-orm";
import type { CoreMessage } from "ai";
import { db } from "../database/client.js";
import { conversations, conversationMessages, type AttachmentMeta, type ReasoningDetail, type StepDetail } from "./schema.js";
import { pipelineTraces } from "../analytics/traces.schema.js";
import { aiLogs } from "../ai-gateway/logger.js";
import { toolAuditLogs } from "../audit/audit.schema.js";

export interface MessageRow {
  role: string;
  content: string;
  /** Per-step breakdown of a multi-step assistant turn. NULL for user/system rows. */
  steps?: StepDetail[] | null;
  /** Aggregated reasoning at the message level. NULL when not produced/persisted. */
  reasoning?: ReasoningDetail[] | null;
  createdAt: Date | null;
}

/**
 * PostgreSQL `text` and `jsonb` columns reject NUL bytes (`\x00`). LLMs
 * occasionally emit them as control-char hallucinations inside otherwise valid
 * output, which would crash `appendMessages` (22021 on text, 22P05 on jsonb).
 * Strip silently at the persistence boundary so a stray control char never
 * blocks an entire pipeline turn.
 */
const NUL = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL, "g");
function stripNulString(s: string): string {
  return s.indexOf(NUL) === -1 ? s : s.replace(NUL_RE, "");
}

function stripNulDeep<T>(value: T): T {
  if (typeof value === "string") return stripNulString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => stripNulDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNulDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface KeywordSearchResult {
  id: string;
  conversationId: string;
  content: string;
  role: string;
  rank: number;
  createdAt: Date | null;
}

export interface ConversationListItem {
  id: string;
  conversationId: string;
  title: string | null;
  summary: string | null;
  instanceId: string | null;
  instanceName: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  conversationTokens: number;
  conversationCost: number;
  serviceTokens: number;
  serviceCost: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export type ConversationDetail = ConversationListItem;

export interface MessageDetail {
  id: string;
  role: string;
  content: string;
  /** Per-step multi-step trace (replaces the legacy `toolCalls` flat array). */
  steps: StepDetail[] | null;
  /** Message-level reasoning (signed thinking blocks for Anthropic, summaries for OpenAI). */
  reasoning: ReasoningDetail[] | null;
  attachments: AttachmentMeta[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | null;
}

export interface ConversationSearchResult extends ConversationListItem {
  matchCount: number;
  bestSnippet: string;
}

/** Simple bounded map that evicts the oldest entry when capacity is exceeded. */
class BoundedMap<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined { return this.map.get(key); }

  set(key: K, value: V): void {
    // Delete first to refresh insertion order on update
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      // Evict the oldest (first) entry
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: K): boolean { return this.map.delete(key); }
}

const CACHE_MAX_SIZE = 1000;

export class ConversationStore {
  private summaryCache = new BoundedMap<string, string>(CACHE_MAX_SIZE);
  private titleCache = new BoundedMap<string, string>(CACHE_MAX_SIZE);

  /** Get conversation title. Checks in-memory cache first, falls back to DB. */
  async getTitle(conversationId: string): Promise<string | null> {
    const cached = this.titleCache.get(conversationId);
    if (cached !== undefined) return cached;

    const rows = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.conversationId, conversationId))
      .limit(1);

    const title = rows[0]?.title ?? null;
    if (title) {
      this.titleCache.set(conversationId, title);
    }
    return title;
  }

  /** Update conversation title in DB and in-memory cache. */
  async updateTitle(conversationId: string, title: string): Promise<void> {
    const safe = stripNulString(title);
    await db
      .update(conversations)
      .set({ title: safe, updatedAt: new Date() })
      .where(eq(conversations.conversationId, conversationId));

    this.titleCache.set(conversationId, safe);
  }

  /** Get conversation summary. Checks in-memory cache first, falls back to DB. */
  async getSummary(conversationId: string): Promise<string | null> {
    const cached = this.summaryCache.get(conversationId);
    if (cached !== undefined) return cached;

    const rows = await db
      .select({ summary: conversations.summary })
      .from(conversations)
      .where(eq(conversations.conversationId, conversationId))
      .limit(1);

    const summary = rows[0]?.summary ?? null;
    if (summary) {
      this.summaryCache.set(conversationId, summary);
    }
    return summary;
  }

  /** Update conversation summary in DB and in-memory cache. */
  async updateSummary(conversationId: string, summary: string): Promise<void> {
    const safe = stripNulString(summary);
    await db
      .update(conversations)
      .set({ summary: safe, updatedAt: new Date() })
      .where(eq(conversations.conversationId, conversationId));

    this.summaryCache.set(conversationId, safe);
  }

  /** Get context prompt for a webhook-triggered conversation. Returns null if not set. */
  async getContextPrompt(conversationId: string): Promise<string | null> {
    const rows = await db
      .select({ contextPrompt: conversations.contextPrompt })
      .from(conversations)
      .where(eq(conversations.conversationId, conversationId))
      .limit(1);

    return rows[0]?.contextPrompt ?? null;
  }

  /**
   * Clear the context prompt for a conversation (set to NULL).
   *
   * The context prompt is populated by webhook triggers and meant to apply
   * only to the trigger turn. Callers invoke this AFTER `supervise()` returns
   * (webhook-engine post-trigger, or pipeline post-turn when the prompt had
   * been loaded) to prevent stale injection on subsequent inbound turns.
   */
  async clearContextPrompt(conversationId: string): Promise<void> {
    await db
      .update(conversations)
      .set({ contextPrompt: null })
      .where(eq(conversations.conversationId, conversationId));
  }

  /**
   * Ensure a conversation row exists. Creates one if missing (idempotent).
   * Returns `{ created: true }` when this call actually inserted the row, so
   * callers can fire `category: "conversation"` lifecycle events on first
   * sight (and stay silent on subsequent turns of the same conversation).
   *
   * Implementation: Postgres exposes `xmax = 0` on rows just inserted (no
   * previous version). For rows touched by `ON CONFLICT DO UPDATE`, `xmax`
   * holds the transaction id of the prior version. We cast to text because
   * `xid` is non-portable. If the RETURNING row is missing for any reason
   * (defensive — should not happen), we default to `created: false`.
   */
  async ensureConversation(
    conversationId: string,
    instanceId?: string,
    options?: { channel?: string; userIdentifier?: string; source?: string; contextPrompt?: string },
  ): Promise<{ created: boolean }> {
    const channel = options?.channel ?? "web";
    const userIdentifier = options?.userIdentifier ?? null;
    const source = options?.source ?? "user";
    const contextPrompt = options?.contextPrompt ?? null;

    const result = await db
      .insert(conversations)
      .values({
        conversationId,
        instanceId: instanceId ?? null,
        channel,
        source,
        userIdentifier,
        contextPrompt,
      })
      .onConflictDoUpdate({
        target: conversations.conversationId,
        set: { channel, userIdentifier, ...(contextPrompt ? { contextPrompt } : {}) },
      })
      .returning({ xmax: sql<string>`xmax::text` });

    return { created: result[0]?.xmax === "0" };
  }

  /** Append messages to a conversation. */
  async appendMessages(
    conversationId: string,
    messages: Array<{
      role: string;
      content: string;
      steps?: StepDetail[];
      reasoning?: ReasoningDetail[];
      attachments?: AttachmentMeta[];
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    if (messages.length === 0) return;

    await db.insert(conversationMessages).values(
      messages.map((m) => ({
        conversationId,
        role: m.role,
        // Postgres `text` rejects NUL bytes; `jsonb` rejects NUL escapes
        // inside string values. Strip both before insert.
        content: stripNulString(m.content),
        steps: m.steps ? stripNulDeep(m.steps) : null,
        reasoning: m.reasoning ? stripNulDeep(m.reasoning) : null,
        attachments: m.attachments ? stripNulDeep(m.attachments) : null,
        metadata: m.metadata ? stripNulDeep(m.metadata) : null,
      })),
    );
  }

  /**
   * Get the most recent N messages for a conversation, ordered chronologically.
   *
   * Returns CoreMessage shape for direct use by the AI gateway. Reasoning is
   * NOT included here — Anthropic signed-block re-injection is handled by a
   * dedicated helper that consumes raw rows via `getRecentMessageRows()`.
   */
  async getRecentMessages(conversationId: string, limit = 15): Promise<CoreMessage[]> {
    const rows = await db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);

    // Reverse to chronological order and map to CoreMessage
    return rows.reverse().map((r) => ({
      role: r.role as "user" | "assistant" | "system",
      content: r.content,
    }));
  }

  /**
   * Get the most recent N messages with full reasoning + steps detail.
   *
   * Used by the AI gateway's reasoning-injector to rebuild Anthropic
   * multi-turn payloads that include the previous turn's signed thinking
   * blocks. Returns chronologically ordered rows.
   */
  async getRecentMessageRows(conversationId: string, limit = 15): Promise<MessageRow[]> {
    const rows = await db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
        steps: conversationMessages.steps,
        reasoning: conversationMessages.reasoning,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);

    return rows.reverse().map((r) => ({
      role: r.role,
      content: r.content,
      steps: (r.steps as StepDetail[] | null) ?? null,
      reasoning: (r.reasoning as ReasoningDetail[] | null) ?? null,
      createdAt: r.createdAt ?? null,
    }));
  }

  /** Full-text search across all conversation messages for an instance. */
  async searchByKeyword(
    query: string,
    instanceId: string | undefined,
    limit = 20,
  ): Promise<KeywordSearchResult[]> {
    // Build the tsquery from the user query (websearch syntax handles natural language)
    const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;

    // Join with conversations to filter by instanceId if provided
    const instanceFilter = instanceId
      ? sql`AND c.instance_id = ${instanceId}`
      : sql``;

    const results = await db.execute(sql`
      SELECT
        cm.id,
        cm.conversation_id,
        cm.content,
        cm.role,
        ts_rank(cm.search_vector, ${tsQuery}) AS rank,
        cm.created_at
      FROM conversation_messages cm
      JOIN conversations c ON c.conversation_id = cm.conversation_id
      WHERE cm.search_vector @@ ${tsQuery}
        ${instanceFilter}
      ORDER BY rank DESC
      LIMIT ${limit}
    `);

    return (results as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      conversationId: r.conversation_id as string,
      content: r.content as string,
      role: r.role as string,
      rank: r.rank as number,
      createdAt: r.created_at ? new Date(r.created_at as string) : null,
    }));
  }

  /** List conversations with message count, optionally filtered by instance. */
  async listConversations(options: {
    instanceId?: string;
    source?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ conversations: ConversationListItem[]; total: number }> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;

    const conditions: ReturnType<typeof sql>[] = [];
    if (options.instanceId) conditions.push(sql`c.instance_id = ${options.instanceId}`);
    if (options.source) conditions.push(sql`c.source = ${options.source}`);
    const instanceFilter = conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

    const [rows, countResult] = await Promise.all([
      db.execute(sql`
        SELECT
          c.id,
          c.conversation_id,
          c.title,
          c.summary,
          c.instance_id,
          i.name AS instance_name,
          COUNT(cm.id)::int AS message_count,
          COALESCE(al_agg.total_tokens, 0)::int AS total_tokens,
          COALESCE(al_agg.total_cost, 0)::real AS total_cost,
          COALESCE(al_agg.conversation_tokens, 0)::int AS conversation_tokens,
          COALESCE(al_agg.conversation_cost, 0)::real AS conversation_cost,
          COALESCE(al_agg.service_tokens, 0)::int AS service_tokens,
          COALESCE(al_agg.service_cost, 0)::real AS service_cost,
          c.created_at,
          c.updated_at
        FROM conversations c
        LEFT JOIN instances i ON i.slug = c.instance_id
        LEFT JOIN conversation_messages cm ON cm.conversation_id = c.conversation_id
        LEFT JOIN LATERAL (
          SELECT SUM(al.total_tokens) AS total_tokens,
                 SUM(al.estimated_cost_usd) AS total_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'service') AS service_cost
          FROM ai_logs al
          WHERE al.conversation_id = c.conversation_id
        ) al_agg ON true
        ${instanceFilter}
        GROUP BY c.id, i.name, al_agg.total_tokens, al_agg.total_cost, al_agg.conversation_tokens, al_agg.conversation_cost, al_agg.service_tokens, al_agg.service_cost
        ORDER BY c.updated_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS total FROM conversations c ${instanceFilter}
      `),
    ]);

    const total = (countResult as unknown as Array<Record<string, unknown>>)[0]?.total as number ?? 0;

    return {
      conversations: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        conversationId: r.conversation_id as string,
        title: (r.title as string) ?? null,
        summary: (r.summary as string) ?? null,
        instanceId: (r.instance_id as string) ?? null,
        instanceName: (r.instance_name as string) ?? null,
        messageCount: (r.message_count as number) ?? 0,
        totalTokens: (r.total_tokens as number) ?? 0,
        totalCost: (r.total_cost as number) ?? 0,
        conversationTokens: (r.conversation_tokens as number) ?? 0,
        conversationCost: (r.conversation_cost as number) ?? 0,
        serviceTokens: (r.service_tokens as number) ?? 0,
        serviceCost: (r.service_cost as number) ?? 0,
        createdAt: r.created_at ? new Date(r.created_at as string) : null,
        updatedAt: r.updated_at ? new Date(r.updated_at as string) : null,
      })),
      total,
    };
  }

  /** Get a single conversation with metadata. */
  async getConversation(conversationId: string): Promise<ConversationDetail | null> {
    const rows = await db.execute(sql`
      SELECT
        c.id,
        c.conversation_id,
        c.title,
        c.summary,
        c.instance_id,
        i.name AS instance_name,
        COUNT(cm.id)::int AS message_count,
        COALESCE(al_agg.total_tokens, 0)::int AS total_tokens,
        COALESCE(al_agg.total_cost, 0)::real AS total_cost,
        COALESCE(al_agg.conversation_tokens, 0)::int AS conversation_tokens,
        COALESCE(al_agg.conversation_cost, 0)::real AS conversation_cost,
        COALESCE(al_agg.service_tokens, 0)::int AS service_tokens,
        COALESCE(al_agg.service_cost, 0)::real AS service_cost,
        c.created_at,
        c.updated_at
      FROM conversations c
      LEFT JOIN instances i ON i.slug = c.instance_id
      LEFT JOIN conversation_messages cm ON cm.conversation_id = c.conversation_id
      LEFT JOIN LATERAL (
        SELECT SUM(al.total_tokens) AS total_tokens,
               SUM(al.estimated_cost_usd) AS total_cost,
               SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
               SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
               SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
               SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'service') AS service_cost
        FROM ai_logs al
        WHERE al.conversation_id = c.conversation_id
      ) al_agg ON true
      WHERE c.conversation_id = ${conversationId}
      GROUP BY c.id, i.name, al_agg.total_tokens, al_agg.total_cost, al_agg.conversation_tokens, al_agg.conversation_cost, al_agg.service_tokens, al_agg.service_cost
    `);

    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) return null;

    return {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      title: (r.title as string) ?? null,
      summary: (r.summary as string) ?? null,
      instanceId: (r.instance_id as string) ?? null,
      instanceName: (r.instance_name as string) ?? null,
      messageCount: (r.message_count as number) ?? 0,
      totalTokens: (r.total_tokens as number) ?? 0,
      totalCost: (r.total_cost as number) ?? 0,
      conversationTokens: (r.conversation_tokens as number) ?? 0,
      conversationCost: (r.conversation_cost as number) ?? 0,
      serviceTokens: (r.service_tokens as number) ?? 0,
      serviceCost: (r.service_cost as number) ?? 0,
      createdAt: r.created_at ? new Date(r.created_at as string) : null,
      updatedAt: r.updated_at ? new Date(r.updated_at as string) : null,
    };
  }

  /** Get paginated messages for a conversation. */
  async getMessages(
    conversationId: string,
    options: { limit?: number; offset?: number; order?: "asc" | "desc" } = {},
  ): Promise<{ messages: MessageDetail[]; total: number }> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const order = options.order ?? "asc";

    const [rows, countResult] = await Promise.all([
      db
        .select({
          id: conversationMessages.id,
          role: conversationMessages.role,
          content: conversationMessages.content,
          steps: conversationMessages.steps,
          reasoning: conversationMessages.reasoning,
          attachments: conversationMessages.attachments,
          metadata: conversationMessages.metadata,
          createdAt: conversationMessages.createdAt,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(order === "desc" ? desc(conversationMessages.createdAt) : asc(conversationMessages.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId)),
    ]);

    return {
      messages: rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        steps: (r.steps as StepDetail[] | null) ?? null,
        reasoning: (r.reasoning as ReasoningDetail[] | null) ?? null,
        attachments: (r.attachments as AttachmentMeta[] | null) ?? null,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        createdAt: r.createdAt ?? null,
      })),
      total: countResult[0]?.total ?? 0,
    };
  }

  /** Search conversations by message content using FTS. Returns conversation-level results. */
  async searchConversations(
    query: string,
    options: { instanceId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ conversations: ConversationSearchResult[]; total: number }> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;

    const instanceFilter = options.instanceId
      ? sql`AND c.instance_id = ${options.instanceId}`
      : sql``;

    const [rows, countResult] = await Promise.all([
      db.execute(sql`
        SELECT
          c.id,
          c.conversation_id,
          c.title,
          c.summary,
          c.instance_id,
          i.name AS instance_name,
          COUNT(cm.id)::int AS match_count,
          (SELECT cm2.content FROM conversation_messages cm2
           WHERE cm2.conversation_id = c.conversation_id
             AND cm2.search_vector @@ ${tsQuery}
           ORDER BY ts_rank(cm2.search_vector, ${tsQuery}) DESC
           LIMIT 1
          ) AS best_snippet,
          (SELECT COUNT(*)::int FROM conversation_messages cm3
           WHERE cm3.conversation_id = c.conversation_id
          ) AS message_count,
          COALESCE(al_agg.total_tokens, 0)::int AS total_tokens,
          COALESCE(al_agg.total_cost, 0)::real AS total_cost,
          COALESCE(al_agg.conversation_tokens, 0)::int AS conversation_tokens,
          COALESCE(al_agg.conversation_cost, 0)::real AS conversation_cost,
          COALESCE(al_agg.service_tokens, 0)::int AS service_tokens,
          COALESCE(al_agg.service_cost, 0)::real AS service_cost,
          c.created_at,
          c.updated_at
        FROM conversations c
        LEFT JOIN instances i ON i.slug = c.instance_id
        JOIN conversation_messages cm ON cm.conversation_id = c.conversation_id
          AND cm.search_vector @@ ${tsQuery}
        LEFT JOIN LATERAL (
          SELECT SUM(al.total_tokens) AS total_tokens,
                 SUM(al.estimated_cost_usd) AS total_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'service') AS service_cost
          FROM ai_logs al
          WHERE al.conversation_id = c.conversation_id
        ) al_agg ON true
        WHERE 1=1 ${instanceFilter}
        GROUP BY c.id, i.name, al_agg.total_tokens, al_agg.total_cost, al_agg.conversation_tokens, al_agg.conversation_cost, al_agg.service_tokens, al_agg.service_cost
        ORDER BY MAX(ts_rank(cm.search_vector, ${tsQuery})) DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(DISTINCT c.id)::int AS total
        FROM conversations c
        JOIN conversation_messages cm ON cm.conversation_id = c.conversation_id
          AND cm.search_vector @@ ${tsQuery}
        WHERE 1=1 ${instanceFilter}
      `),
    ]);

    const total = (countResult as unknown as Array<Record<string, unknown>>)[0]?.total as number ?? 0;

    return {
      conversations: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        conversationId: r.conversation_id as string,
        title: (r.title as string) ?? null,
        summary: (r.summary as string) ?? null,
        instanceId: (r.instance_id as string) ?? null,
        instanceName: (r.instance_name as string) ?? null,
        matchCount: (r.match_count as number) ?? 0,
        bestSnippet: (r.best_snippet as string) ?? "",
        messageCount: (r.message_count as number) ?? 0,
        totalTokens: (r.total_tokens as number) ?? 0,
        totalCost: (r.total_cost as number) ?? 0,
        conversationTokens: (r.conversation_tokens as number) ?? 0,
        conversationCost: (r.conversation_cost as number) ?? 0,
        serviceTokens: (r.service_tokens as number) ?? 0,
        serviceCost: (r.service_cost as number) ?? 0,
        createdAt: r.created_at ? new Date(r.created_at as string) : null,
        updatedAt: r.updated_at ? new Date(r.updated_at as string) : null,
      })),
      total,
    };
  }

  /** Get per-message token stats by correlating messages with pipeline_traces. */
  async getMessageTokenStats(
    conversationId: string,
  ): Promise<Record<string, { promptTokens: number; completionTokens: number }>> {
    const [msgs, traces] = await Promise.all([
      db
        .select({
          id: conversationMessages.id,
          role: conversationMessages.role,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(asc(conversationMessages.createdAt)),
      db
        .select({
          promptTokens: pipelineTraces.promptTokens,
          completionTokens: pipelineTraces.completionTokens,
        })
        .from(pipelineTraces)
        .where(eq(pipelineTraces.conversationId, conversationId))
        .orderBy(asc(pipelineTraces.createdAt)),
    ]);

    // Group messages into exchanges (user → optional assistant)
    const exchanges: Array<{ userId: string; assistantId?: string }> = [];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "user") {
        const exchange: { userId: string; assistantId?: string } = { userId: msgs[i].id };
        if (i + 1 < msgs.length && msgs[i + 1].role === "assistant") {
          exchange.assistantId = msgs[i + 1].id;
        }
        exchanges.push(exchange);
      }
    }

    // Map each exchange to its trace (1:1 by order)
    const result: Record<string, { promptTokens: number; completionTokens: number }> = {};
    for (let i = 0; i < exchanges.length; i++) {
      const trace = traces[i];
      if (!trace) break;
      const prompt = trace.promptTokens ?? 0;
      const completion = trace.completionTokens ?? 0;
      result[exchanges[i].userId] = { promptTokens: prompt, completionTokens: 0 };
      if (exchanges[i].assistantId) {
        result[exchanges[i].assistantId!] = { promptTokens: 0, completionTokens: completion };
      }
    }

    return result;
  }

  /** Replace the N oldest messages with a summary system message. Used by room history compaction. */
  async replaceOldestMessages(conversationId: string, messageCount: number, summary: string): Promise<void> {
    // Wrapped in a transaction so delete + insert are atomic.
    // A crash between them would otherwise leave the conversation with no summary and missing messages.
    await db.transaction(async (tx) => {
      const oldest = await tx
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(conversationMessages.createdAt)
        .limit(messageCount);

      if (oldest.length === 0) return;

      const idsToDelete = oldest.map((r) => r.id);

      await tx.delete(conversationMessages).where(inArray(conversationMessages.id, idsToDelete));
      await tx.insert(conversationMessages).values({
        conversationId,
        role: "system",
        content: `[Room history summary]\n${summary}`,
      });
    });
  }

  /** Delete a conversation and all its messages (atomic). */
  async deleteConversation(conversationId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      // Drop everything tied to this conversation_id in one transaction so the
      // UI counters (token totals, traces, audit) match what's actually visible.
      // Tables intentionally left alone:
      //   - instance_room: not a per-conversation FK (one-to-one with instance)
      //   - scheduled_task_runs: independent execution history
      await tx
        .delete(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId));
      await tx.delete(aiLogs).where(eq(aiLogs.conversationId, conversationId));
      await tx
        .delete(pipelineTraces)
        .where(eq(pipelineTraces.conversationId, conversationId));
      await tx
        .delete(toolAuditLogs)
        .where(eq(toolAuditLogs.conversationId, conversationId));

      const result = await tx
        .delete(conversations)
        .where(eq(conversations.conversationId, conversationId))
        .returning();

      this.summaryCache.delete(conversationId);
      this.titleCache.delete(conversationId);
      return result.length > 0;
    });
  }
}

export const conversationStore = new ConversationStore();
