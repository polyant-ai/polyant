// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, desc, asc, sql, count, inArray, type SQL } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { db } from "../database/client.js";
import { conversations, conversationMessages, conversationState, type AttachmentMeta, type LlmDebugPayload, type ReasoningDetail, type StepDetail } from "./schema.js";
import { pipelineTraces } from "../analytics/traces.schema.js";
import type { CostBreakdown } from "../ai-gateway/types.js";
import { aiLogs } from "../ai-gateway/logger.js";
import { toolAuditLogs } from "../audit/audit.schema.js";
import { hookExecutions } from "../hooks/hooks.schema.js";
import { memories } from "../memory/schema.js";
import { principalSecrets } from "./principal-secrets.schema.js";
import { asInstanceSlug, type InstanceSlug } from "../instances/identifiers.js";
import { buildOrgScopedAgentFilter, buildOrgScopedAgentFilterFragment } from "../authz/scope-filter.js";

/**
 * Explicit opt-out of the org-scoping filter, for INTERNAL/system callers that
 * run outside any request and therefore have no organization to scope to (e.g.
 * the `conversation-reset` hook checking whether an archive id is already taken).
 *
 * It is a `Symbol` on purpose: `buildOrgScopedAgentFilterFragment` fails closed
 * (`and false`) when no `orgId` is given, so an internal caller passing nothing
 * silently got zero rows. Handing those callers a system scope has to be
 * unmistakable AND unreachable from a request — a symbol can never be produced by
 * JSON body/query parsing, so no HTTP input can ever widen the tenancy filter.
 */
export const SYSTEM_SCOPE = Symbol("conversation-store:system-scope");

/** Either a caller organization id, or the explicit internal system scope. */
export type ConversationScope = string | typeof SYSTEM_SCOPE | undefined;

/**
 * Org-filter fragment for a `ConversationScope`: an empty (unconstrained)
 * fragment ONLY for the explicit system scope, otherwise the fail-closed
 * org-scoped predicate.
 */
function scopeFilterFragment(scope: ConversationScope, columnName: "c.instance_id"): SQL {
  if (scope === SYSTEM_SCOPE) return sql``;
  return buildOrgScopedAgentFilterFragment(scope, columnName);
}

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

/** Max persisted length of a conversation title (display-only text). */
export const MAX_TITLE_CHARS = 120;

/** First non-empty line, collapsed whitespace, hard-capped at MAX_TITLE_CHARS. */
export function normalizeTitle(title: string): string {
  const firstLine = title
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length <= MAX_TITLE_CHARS
    ? collapsed
    : collapsed.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + "…";
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

/**
 * Escape LIKE/ILIKE wildcards (`%`, `_`) and the escape char (`\`) so user
 * input is matched literally when interpolated into a pattern.
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
  channel: string | null;
  instanceId: InstanceSlug | null;
  instanceName: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  conversationTokens: number;
  conversationCost: number;
  serviceTokens: number;
  serviceCost: number;
  /**
   * Prompt-cache reads (cache HIT) for this conversation's `conversation` calls
   * only — NOT service/auto-task calls (title/summary/memory). Scoped this way so
   * the list reconciles with the per-message telemetry, which is conversation-only
   * (pipeline_traces skips auto-tasks). Subset of `conversationTokens`' input.
   */
  cachedInputTokens: number;
  /** Prompt-cache writes (cache creation) for this conversation's `conversation` calls only. */
  cacheCreationInputTokens: number;
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

/**
 * Per-message telemetry merged into the messages API. Prompt tokens land on the
 * user message; completion tokens + cache + model + cost land on the assistant
 * message. Cache/model/cost are null for legacy rows without a linked trace.
 */
export interface MessageMetadata {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  model?: string | null;
  provider?: string | null;
  cost?: CostBreakdown | null;
  thinking?: boolean | null;
  temperature?: number | null;
  /** Per-phase latency (ms) for the assistant turn. */
  latency?: {
    contextPrepMs: number | null;
    toolBuildingMs: number | null;
    llmCallMs: number | null;
    totalMs: number | null;
    ttfbMs: number | null;
  };
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

  /**
   * Update conversation title in DB and in-memory cache.
   *
   * A title is a single short display line: the LLM asked for "6-8 words"
   * occasionally answers with a paragraph (or a preamble + newline + title),
   * and a rename via the API is unbounded. Normalize at the persistence
   * boundary — the one chokepoint every writer goes through — so no consumer
   * has to defend against a 5000-char "title".
   */
  async updateTitle(conversationId: string, title: string): Promise<void> {
    const safe = normalizeTitle(stripNulString(title));
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
    instanceId?: InstanceSlug,
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
      /** Explicit row id. When omitted the column default (random UUID) is used. */
      id?: string;
      /** Explicit created_at. When omitted the column default (now()) is used — set it
       * to a message's true arrival time so a commit-on-success user row is not stamped
       * at end-of-turn (which also keeps the user row ordered before the assistant). */
      createdAt?: Date;
      role: string;
      content: string;
      steps?: StepDetail[];
      reasoning?: ReasoningDetail[];
      attachments?: AttachmentMeta[];
      metadata?: Record<string, unknown>;
      /** Exact LLM request payload (DEBUG mode only). NULL otherwise. */
      debugPayload?: LlmDebugPayload;
    }>,
  ): Promise<void> {
    if (messages.length === 0) return;

    // Insert + `updated_at` bump are one transaction: the conversation list
    // orders by `updated_at` and the `updatedSince`/`updatedUntil` filters range
    // over it, so a row whose last message is newer than its `updated_at` sorts
    // stale and is missed by incremental pulls. Before this, only title/summary
    // writes moved the column — never the messages themselves.
    await db.transaction(async (tx) => {
      await tx.insert(conversationMessages).values(
        messages.map((m) => ({
          ...(m.id ? { id: m.id } : {}),
          ...(m.createdAt ? { createdAt: m.createdAt } : {}),
          conversationId,
          role: m.role,
          // Postgres `text` rejects NUL bytes; `jsonb` rejects NUL escapes
          // inside string values. Strip both before insert.
          content: stripNulString(m.content),
          steps: m.steps ? stripNulDeep(m.steps) : null,
          reasoning: m.reasoning ? stripNulDeep(m.reasoning) : null,
          attachments: m.attachments ? stripNulDeep(m.attachments) : null,
          metadata: m.metadata ? stripNulDeep(m.metadata) : null,
          debugPayload: m.debugPayload ? stripNulDeep(m.debugPayload) : null,
        })),
      );

      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.conversationId, conversationId));
    });
  }

  /**
   * Get the most recent N messages for a conversation, ordered chronologically.
   *
   * Returns ModelMessage shape for direct use by the AI gateway. Reasoning is
   * NOT included here — Anthropic signed-block re-injection is handled by a
   * dedicated helper that consumes raw rows via `getRecentMessageRows()`.
   */
  async getRecentMessages(conversationId: string, limit = 15): Promise<ModelMessage[]> {
    const rows = await db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(limit);

    // Reverse to chronological order and map to ModelMessage
    return rows.reverse().map((r) => ({
      role: r.role as "user" | "assistant" | "system",
      content: r.content,
    }));
  }

  /**
   * Return the set of distinct `system` message contents already persisted in
   * a conversation. Used to deduplicate incoming system messages at write time:
   * any client that replays the conversation history (the admin playground, an
   * OpenAI-compatible client like open-webui) re-sends the same `system` block
   * every turn, which would otherwise accumulate one duplicate row per turn and
   * surface as a repeated context card in the conversation UI. The canonical
   * copy stays in history (loaded by getRecentMessages), so the model still
   * sees the context — only the duplicate write is suppressed.
   */
  async getSystemMessageContents(conversationId: string): Promise<Set<string>> {
    const rows = await db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversationId),
          eq(conversationMessages.role, "system"),
        ),
      );
    return new Set(rows.map((r) => r.content));
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
    instanceId: InstanceSlug | undefined,
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

  /**
   * List conversations with message count, optionally filtered by instance.
   *
   * `updatedSince`/`updatedUntil` bound the half-open window `[since, until)`
   * on `updated_at` — the field this list already sorts by and that the
   * `idx_conversations_instance_updated` index covers, so windowed polling
   * (e.g. an external analytics pull) stays index-supported. Note `updated_at`
   * tracks last *activity* (bumped when the post-turn summary/title regenerates),
   * not every message insert, so incremental pullers should overlap windows.
   */
  async listConversations(options: {
    instanceId?: InstanceSlug;
    source?: string;
    updatedSince?: Date;
    updatedUntil?: Date;
    limit?: number;
    offset?: number;
    orgId?: string;
  } = {}): Promise<{ conversations: ConversationListItem[]; total: number }> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;

    const conditions: ReturnType<typeof sql>[] = [];
    if (options.instanceId) conditions.push(sql`c.instance_id = ${options.instanceId}`);
    if (options.source) conditions.push(sql`c.source = ${options.source}`);
    if (options.updatedSince) conditions.push(sql`c.updated_at >= ${options.updatedSince.toISOString()}::timestamptz`);
    if (options.updatedUntil) conditions.push(sql`c.updated_at < ${options.updatedUntil.toISOString()}::timestamptz`);
    // Cross-org gate: an aggregate list (no instanceId) returns only caller-org
    // rows; a foreign-org instanceId param yields zero rows (ANDed at the store).
    if (options.orgId) conditions.push(buildOrgScopedAgentFilter(options.orgId, "c.instance_id"));
    const instanceFilter = conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

    const [rows, countResult] = await Promise.all([
      // message_count is a scalar subquery (not a JOIN + GROUP BY): a fan-out
      // join over conversation_messages would force Postgres to aggregate the
      // whole messages table before ORDER BY/LIMIT, so listing 20 rows scaled
      // with the entire DB. The subquery + LATERAL now run only for the returned rows.
      db.execute(sql`
        SELECT
          c.id,
          c.conversation_id,
          c.title,
          c.summary,
          c.channel,
          c.instance_id,
          i.name AS instance_name,
          (SELECT COUNT(*)::int FROM conversation_messages cm
           WHERE cm.conversation_id = c.conversation_id) AS message_count,
          COALESCE(al_agg.total_tokens, 0)::int AS total_tokens,
          COALESCE(al_agg.total_cost, 0)::real AS total_cost,
          COALESCE(al_agg.conversation_tokens, 0)::int AS conversation_tokens,
          COALESCE(al_agg.conversation_cost, 0)::real AS conversation_cost,
          COALESCE(al_agg.service_tokens, 0)::int AS service_tokens,
          COALESCE(al_agg.service_cost, 0)::real AS service_cost,
          COALESCE(al_agg.cached_input_tokens, 0)::int AS cached_input_tokens,
          COALESCE(al_agg.cache_creation_input_tokens, 0)::int AS cache_creation_input_tokens,
          c.created_at,
          c.updated_at
        FROM conversations c
        LEFT JOIN instances i ON i.slug = c.instance_id
        LEFT JOIN LATERAL (
          SELECT SUM(al.total_tokens) AS total_tokens,
                 SUM(al.estimated_cost_usd) AS total_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'service') AS service_cost,
                 SUM(al.cached_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cached_input_tokens,
                 SUM(al.cache_creation_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cache_creation_input_tokens
          FROM ai_logs al
          WHERE al.conversation_id = c.conversation_id
        ) al_agg ON true
        ${instanceFilter}
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
        channel: (r.channel as string) ?? null,
        instanceId: r.instance_id ? asInstanceSlug(r.instance_id as string) : null,
        instanceName: (r.instance_name as string) ?? null,
        messageCount: (r.message_count as number) ?? 0,
        totalTokens: (r.total_tokens as number) ?? 0,
        totalCost: (r.total_cost as number) ?? 0,
        conversationTokens: (r.conversation_tokens as number) ?? 0,
        conversationCost: (r.conversation_cost as number) ?? 0,
        serviceTokens: (r.service_tokens as number) ?? 0,
        serviceCost: (r.service_cost as number) ?? 0,
        cachedInputTokens: (r.cached_input_tokens as number) ?? 0,
        cacheCreationInputTokens: (r.cache_creation_input_tokens as number) ?? 0,
        createdAt: r.created_at ? new Date(r.created_at as string) : null,
        updatedAt: r.updated_at ? new Date(r.updated_at as string) : null,
      })),
      total,
    };
  }

  /**
   * Get a single conversation with metadata.
   *
   * @param scope the caller's organization id, or `SYSTEM_SCOPE` for an internal
   *   caller with no organization. Omitting it fails CLOSED (always null) — never
   *   pass nothing just to "skip" the filter.
   */
  async getConversation(
    conversationId: string,
    scope?: ConversationScope,
  ): Promise<ConversationDetail | null> {
    // Cross-org gate: scoping the lookup to the caller's org turns a foreign-org
    // conversation id into a "not found" (the controller maps null → 404).
    const orgFilter = scopeFilterFragment(scope, "c.instance_id");
    const rows = await db.execute(sql`
      SELECT
        c.id,
        c.conversation_id,
        c.title,
        c.summary,
        c.channel,
        c.instance_id,
        i.name AS instance_name,
        COUNT(cm.id)::int AS message_count,
        COALESCE(al_agg.total_tokens, 0)::int AS total_tokens,
        COALESCE(al_agg.total_cost, 0)::real AS total_cost,
        COALESCE(al_agg.conversation_tokens, 0)::int AS conversation_tokens,
        COALESCE(al_agg.conversation_cost, 0)::real AS conversation_cost,
        COALESCE(al_agg.service_tokens, 0)::int AS service_tokens,
        COALESCE(al_agg.service_cost, 0)::real AS service_cost,
        COALESCE(al_agg.cached_input_tokens, 0)::int AS cached_input_tokens,
        COALESCE(al_agg.cache_creation_input_tokens, 0)::int AS cache_creation_input_tokens,
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
               SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'service') AS service_cost,
               SUM(al.cached_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cached_input_tokens,
               SUM(al.cache_creation_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cache_creation_input_tokens
        FROM ai_logs al
        WHERE al.conversation_id = c.conversation_id
      ) al_agg ON true
      WHERE c.conversation_id = ${conversationId} ${orgFilter}
      GROUP BY c.id, i.name, al_agg.total_tokens, al_agg.total_cost, al_agg.conversation_tokens, al_agg.conversation_cost, al_agg.service_tokens, al_agg.service_cost, al_agg.cached_input_tokens, al_agg.cache_creation_input_tokens
    `);

    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) return null;

    return {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      title: (r.title as string) ?? null,
      summary: (r.summary as string) ?? null,
      channel: (r.channel as string) ?? null,
      instanceId: r.instance_id ? asInstanceSlug(r.instance_id as string) : null,
      instanceName: (r.instance_name as string) ?? null,
      messageCount: (r.message_count as number) ?? 0,
      totalTokens: (r.total_tokens as number) ?? 0,
      totalCost: (r.total_cost as number) ?? 0,
      conversationTokens: (r.conversation_tokens as number) ?? 0,
      conversationCost: (r.conversation_cost as number) ?? 0,
      serviceTokens: (r.service_tokens as number) ?? 0,
      serviceCost: (r.service_cost as number) ?? 0,
      cachedInputTokens: (r.cached_input_tokens as number) ?? 0,
      cacheCreationInputTokens: (r.cache_creation_input_tokens as number) ?? 0,
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

  /**
   * Fetch the heavy per-turn debug data for a single message: the captured LLM
   * request payload (DEBUG mode only) plus the multi-step tool trace. Scoped by
   * conversationId so a message id cannot be read out of its conversation.
   * Returns null when the message does not exist in that conversation.
   */
  async getMessageDebug(
    conversationId: string,
    messageId: string,
  ): Promise<{ debugPayload: LlmDebugPayload | null; steps: StepDetail[] | null } | null> {
    const rows = await db
      .select({
        debugPayload: conversationMessages.debugPayload,
        steps: conversationMessages.steps,
      })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      debugPayload: (row.debugPayload as LlmDebugPayload | null) ?? null,
      steps: (row.steps as StepDetail[] | null) ?? null,
    };
  }

  /**
   * Search conversations by message content (FTS) or by conversation id
   * substring (case-insensitive). Returns conversation-level results.
   */
  async searchConversations(
    query: string,
    options: { instanceId?: InstanceSlug; limit?: number; offset?: number; orgId?: string } = {},
  ): Promise<{ conversations: ConversationSearchResult[]; total: number }> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
    const idPattern = `%${escapeLikePattern(query)}%`;

    // Cross-org gate: a search with no instanceId stays scoped to the caller-org
    // rows; a foreign-org instanceId param yields zero rows.
    const orgFilter = buildOrgScopedAgentFilterFragment(options.orgId, "c.instance_id");
    const instanceFilter = options.instanceId
      ? sql`AND c.instance_id = ${options.instanceId} ${orgFilter}`
      : orgFilter;

    const matchFilter = sql`(
      c.conversation_id ILIKE ${idPattern}
      OR EXISTS (
        SELECT 1 FROM conversation_messages cmx
        WHERE cmx.conversation_id = c.conversation_id
          AND cmx.search_vector @@ ${tsQuery}
      )
    )`;

    const [rows, countResult] = await Promise.all([
      db.execute(sql`
        SELECT
          c.id,
          c.conversation_id,
          c.title,
          c.summary,
          c.channel,
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
          COALESCE(al_agg.cached_input_tokens, 0)::int AS cached_input_tokens,
          COALESCE(al_agg.cache_creation_input_tokens, 0)::int AS cache_creation_input_tokens,
          c.created_at,
          c.updated_at
        FROM conversations c
        LEFT JOIN instances i ON i.slug = c.instance_id
        LEFT JOIN conversation_messages cm ON cm.conversation_id = c.conversation_id
          AND cm.search_vector @@ ${tsQuery}
        LEFT JOIN LATERAL (
          SELECT SUM(al.total_tokens) AS total_tokens,
                 SUM(al.estimated_cost_usd) AS total_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
                 SUM(al.estimated_cost_usd) FILTER (WHERE al.call_type = 'service') AS service_cost,
                 SUM(al.cached_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cached_input_tokens,
                 SUM(al.cache_creation_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cache_creation_input_tokens
          FROM ai_logs al
          WHERE al.conversation_id = c.conversation_id
        ) al_agg ON true
        WHERE ${matchFilter} ${instanceFilter}
        GROUP BY c.id, i.name, al_agg.total_tokens, al_agg.total_cost, al_agg.conversation_tokens, al_agg.conversation_cost, al_agg.service_tokens, al_agg.service_cost, al_agg.cached_input_tokens, al_agg.cache_creation_input_tokens
        ORDER BY MAX(ts_rank(cm.search_vector, ${tsQuery})) DESC NULLS LAST, c.updated_at DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM conversations c
        WHERE ${matchFilter} ${instanceFilter}
      `),
    ]);

    const total = (countResult as unknown as Array<Record<string, unknown>>)[0]?.total as number ?? 0;

    return {
      conversations: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        conversationId: r.conversation_id as string,
        title: (r.title as string) ?? null,
        summary: (r.summary as string) ?? null,
        channel: (r.channel as string) ?? null,
        instanceId: r.instance_id ? asInstanceSlug(r.instance_id as string) : null,
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
        cachedInputTokens: (r.cached_input_tokens as number) ?? 0,
        cacheCreationInputTokens: (r.cache_creation_input_tokens as number) ?? 0,
        createdAt: r.created_at ? new Date(r.created_at as string) : null,
        updatedAt: r.updated_at ? new Date(r.updated_at as string) : null,
      })),
      total,
    };
  }

  /**
   * Get per-message metadata (tokens, cache, model, cost) by correlating
   * messages with pipeline_traces. Prefers the robust message_id link when any
   * trace carries it; falls back to positional (ordinal) matching for
   * fully-legacy conversations whose traces predate the message_id column.
   */
  async getMessageTokenStats(
    conversationId: string,
  ): Promise<Record<string, MessageMetadata>> {
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
          messageId: pipelineTraces.messageId,
          promptTokens: pipelineTraces.promptTokens,
          completionTokens: pipelineTraces.completionTokens,
          cachedInputTokens: pipelineTraces.cachedInputTokens,
          cacheCreationInputTokens: pipelineTraces.cacheCreationInputTokens,
          model: pipelineTraces.model,
          provider: pipelineTraces.provider,
          cost: pipelineTraces.cost,
          thinking: pipelineTraces.thinking,
          temperature: pipelineTraces.temperature,
          contextPrepMs: pipelineTraces.contextPrepMs,
          toolBuildingMs: pipelineTraces.toolBuildingMs,
          llmCallMs: pipelineTraces.llmCallMs,
          totalMs: pipelineTraces.totalMs,
          ttfbMs: pipelineTraces.ttfbMs,
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

    type Trace = (typeof traces)[number];
    const result: Record<string, MessageMetadata> = {};
    // The user message shows the turn's input tokens; the assistant message
    // carries the full turn telemetry (input + output + cache + model + cost)
    // so its per-message pill bar can render the input/cache/output split.
    const assign = (ex: { userId: string; assistantId?: string }, trace: Trace) => {
      result[ex.userId] = { promptTokens: trace.promptTokens ?? 0, completionTokens: 0 };
      if (ex.assistantId) {
        result[ex.assistantId] = {
          promptTokens: trace.promptTokens ?? 0,
          completionTokens: trace.completionTokens ?? 0,
          cachedInputTokens: trace.cachedInputTokens ?? 0,
          cacheCreationInputTokens: trace.cacheCreationInputTokens ?? 0,
          model: trace.model ?? null,
          provider: trace.provider ?? null,
          cost: trace.cost ?? null,
          thinking: trace.thinking ?? null,
          temperature: trace.temperature ?? null,
          latency: {
            contextPrepMs: trace.contextPrepMs ?? null,
            toolBuildingMs: trace.toolBuildingMs ?? null,
            llmCallMs: trace.llmCallMs ?? null,
            totalMs: trace.totalMs ?? null,
            ttfbMs: trace.ttfbMs ?? null,
          },
        };
      }
    };

    if (traces.some((t) => t.messageId != null)) {
      // Robust path: link each exchange's assistant message to its trace by id.
      const byMessageId = new Map<string, Trace>();
      for (const t of traces) if (t.messageId) byMessageId.set(t.messageId, t);
      for (const ex of exchanges) {
        const trace = ex.assistantId ? byMessageId.get(ex.assistantId) : undefined;
        if (trace) assign(ex, trace);
      }
    } else {
      // Legacy fallback: 1:1 positional match (traces predate message_id).
      for (let i = 0; i < exchanges.length; i++) {
        const trace = traces[i];
        if (!trace) break;
        assign(exchanges[i], trace);
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
  /**
   * Rename a conversation's stable text key across every table that stores it,
   * optionally updating the title. Mirrors the `deleteConversation` cascade's
   * table set — UPDATE instead of DELETE — so nothing is orphaned and the
   * renamed conversation stays fully browsable. When `newConversationId` equals
   * `conversationId` only the title is touched. Runs in one transaction; the
   * caller guarantees the new id is free (the unique constraint is the backstop).
   *
   * Side effect by design: renaming a channel conversation away from its
   * canonical `<slug>:<channel>:<identity>` key means the next inbound message
   * recomputes that key, finds no rows, and starts a fresh conversation — a
   * "reset" that preserves the archived history.
   */
  async renameConversation(
    conversationId: string,
    newConversationId: string,
    title?: string,
  ): Promise<boolean> {
    const idChanged = newConversationId !== conversationId;
    return db.transaction(async (tx) => {
      if (idChanged) {
        await tx
          .update(conversationMessages)
          .set({ conversationId: newConversationId })
          .where(eq(conversationMessages.conversationId, conversationId));
        await tx
          .update(aiLogs)
          .set({ conversationId: newConversationId })
          .where(eq(aiLogs.conversationId, conversationId));
        await tx
          .update(pipelineTraces)
          .set({ conversationId: newConversationId })
          .where(eq(pipelineTraces.conversationId, conversationId));
        await tx
          .update(toolAuditLogs)
          .set({ conversationId: newConversationId })
          .where(eq(toolAuditLogs.conversationId, conversationId));
        await tx
          .update(hookExecutions)
          .set({ conversationId: newConversationId })
          .where(eq(hookExecutions.conversationId, conversationId));
        await tx
          .update(memories)
          .set({ sourceConversationId: newConversationId })
          .where(eq(memories.sourceConversationId, conversationId));
        await tx
          .update(conversationState)
          .set({ scopeKey: newConversationId })
          .where(
            and(
              eq(conversationState.scope, "conversation"),
              eq(conversationState.scopeKey, conversationId),
            ),
          );
      }

      const result = await tx
        .update(conversations)
        .set({
          ...(idChanged ? { conversationId: newConversationId } : {}),
          ...(title !== undefined ? { title: stripNulString(title) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(conversations.conversationId, conversationId))
        .returning();

      // Caches are keyed by the id — drop stale entries for both old and new.
      this.summaryCache.delete(conversationId);
      this.titleCache.delete(conversationId);
      this.summaryCache.delete(newConversationId);
      this.titleCache.delete(newConversationId);

      return result.length > 0;
    });
  }

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
      // Hook execution telemetry — per-conversation, dropped with it.
      await tx
        .delete(hookExecutions)
        .where(eq(hookExecutions.conversationId, conversationId));
      // Memories extracted from this conversation: drop them too, so deleting a
      // conversation leaves no derived facts behind (right-to-be-forgotten).
      await tx
        .delete(memories)
        .where(eq(memories.sourceConversationId, conversationId));
      // Conversation state store (per-conversation KV, incl. trusted channel
      // identity) — drop it so deleting a conversation leaves no derived state.
      await tx
        .delete(conversationState)
        .where(
          and(
            eq(conversationState.scope, "conversation"),
            eq(conversationState.scopeKey, conversationId),
          ),
        );
      // principal_secrets (encrypted per-conversation OAuth tokens) share the
      // conversation scope/scope_key keying — drop them too so deleting a
      // conversation leaves no third-party access behind (right-to-be-forgotten).
      await tx
        .delete(principalSecrets)
        .where(
          and(
            eq(principalSecrets.scope, "conversation"),
            eq(principalSecrets.scopeKey, conversationId),
          ),
        );

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
