// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, desc, asc, sql, count, inArray } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { db, type DbTransaction } from "../database/client.js";
import { conversations, conversationMessages, conversationState, type AttachmentMeta, type LlmDebugPayload, type ReasoningDetail, type StepDetail } from "./schema.js";
import { pipelineTraces } from "../analytics/traces.schema.js";
import type { CostBreakdown } from "../ai-gateway/types.js";
import { aiLogs } from "../ai-gateway/logger.js";
import { toolAuditLogs } from "../audit/audit.schema.js";
import { hookExecutions } from "../hooks/hooks.schema.js";
import { memories } from "../memory/schema.js";
import { principalSecrets } from "./principal-secrets.schema.js";
import { notifyConversationChanged } from "./live-updates.js";
import { asInstanceSlug, type InstanceSlug } from "../instances/identifiers.js";
import {
  buildOrgScopedAgentFilterFragment,
  tenantScopedAgentCondition,
  type TenantScope,
} from "../authz/scope-filter.js";

/** The text-only ModelMessage view of stored rows, in the shape `getRecentMessages` returns. */
export function rowsToModelMessages(rows: readonly MessageRow[]): ModelMessage[] {
  return rows.map((r) => ({ role: r.role as "user" | "assistant" | "system", content: r.content }));
}

/** Recent rows and the summary state from one snapshot (`getHistorySnapshot`). */
export interface HistorySnapshot {
  rows: MessageRow[];
  /** Null when no rows were read or the conversation row is missing. */
  summary: string | null;
  summaryThrough: number | null;
  userMessageCount: number | null;
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

const WRAPPING_QUOTES_RE = /^["'“”‘’«»`]+|["'“”‘’«»`]+$/g;
const SPEAKER_LABEL_RE = /^(?:user|utente|assistant|assistente)\s*:\s*/i;

/**
 * First non-empty line, without a leading speaker label ("User:", "Utente:",
 * "Assistant:") or wrapping quotes, collapsed whitespace, hard-capped at
 * MAX_TITLE_CHARS. The model sometimes echoes the transcript format it was fed.
 */
export function normalizeTitle(title: string): string {
  const firstLine = title
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  const collapsed = firstLine
    .replace(WRAPPING_QUOTES_RE, "")
    .replace(SPEAKER_LABEL_RE, "")
    .replace(WRAPPING_QUOTES_RE, "")
    .trim()
    .replace(/\s+/g, " ");
  return collapsed.length <= MAX_TITLE_CHARS
    ? collapsed
    : collapsed.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + "…";
}

/** A title as shown: older rows still carry the transcript label the model once echoed ("User: "). */
function displayTitle(title: string | null): string | null {
  return title === null || title === undefined ? null : title.replace(SPEAKER_LABEL_RE, "");
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
  /** The contact exactly as stored (email, phone number, channel handle), when the channel gave one. */
  userIdentifier: string | null;
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
/** One model call made during a turn, as `ai_logs` recorded it. */
export interface TurnModelCall {
  /** "conversation" for the agent's answer, "service" for the calls around it, "embedding" for an embedder. */
  callType: string;
  provider: string;
  model: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  outcome: string;
  errorKind: string | null;
  createdAt: string | null;
}

/** Everything the per-message Debug sheet loads on open. */
export interface MessageDebug {
  /** Null when the turn was generated with DEBUG off. */
  debugPayload: LlmDebugPayload | null;
  steps: StepDetail[] | null;
  /** How the turn arrived; null for a message with no pipeline trace. */
  turn: {
    channel: string;
    streaming: boolean;
    speechToText: { provider: string; durationMs: number | null; audioDurationSec: number | null } | null;
  } | null;
  modelCalls: TurnModelCall[];
}

export interface MessageMetadata {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** The 5-minute-TTL share of `cacheCreationInputTokens`; null when the turn reported no TTL split. */
  cacheCreation5mInputTokens?: number | null;
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

  /**
   * The stored `summary_through`, read fresh: a summary refresh checks that the
   * marker it was planned on still stands before paying for its call. Undefined
   * when the conversation row does not exist.
   */
  async getSummaryThrough(conversationId: string): Promise<number | null | undefined> {
    const rows = await db
      .select({ summaryThrough: conversations.summaryThrough })
      .from(conversations)
      .where(eq(conversations.conversationId, conversationId))
      .limit(1);
    return rows.length === 0 ? undefined : (rows[0].summaryThrough ?? null);
  }

  /**
   * Update conversation summary in DB.
   *
   * With `cover`, the write also moves `summary_through` and lands only while the
   * stored marker still equals `cover.expected`: a refresh that lost the race to
   * another one is dropped instead of folding the same exchanges twice. Returns
   * whether the row was written.
   */
  async updateSummary(
    conversationId: string,
    summary: string,
    cover?: { expected: number | null; through: number },
  ): Promise<boolean> {
    const safe = stripNulString(summary);
    if (!cover) {
      await db
        .update(conversations)
        .set({ summary: safe, updatedAt: new Date() })
        .where(eq(conversations.conversationId, conversationId));
    } else {
      const written = await db
        .update(conversations)
        .set({ summary: safe, summaryThrough: cover.through, updatedAt: new Date() })
        .where(
          and(
            eq(conversations.conversationId, conversationId),
            sql`${conversations.summaryThrough} IS NOT DISTINCT FROM ${cover.expected}`,
          ),
        )
        .returning({ id: conversations.id });
      // Another refresh moved the marker: this one is dropped.
      if (written.length === 0) return false;
    }
    return true;
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
    instanceId: InstanceSlug,
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
        instanceId,
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
      const inserted = await tx.insert(conversationMessages).values(
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
      ).returning({ createdAt: conversationMessages.createdAt });

      // The counters ride on the update that already runs (migration
      // conversation_message_counters).
      // The latest created_at comes back from the insert, so a message that
      // carries its own timestamp and one stamped by the database count alike.
      const userCount = messages.filter((m) => m.role === "user").length;
      const latest = inserted.reduce<Date | null>(
        (max, r) => (r.createdAt && (!max || r.createdAt > max) ? r.createdAt : max),
        null,
      );
      await tx
        .update(conversations)
        .set({
          updatedAt: new Date(),
          messageCount: sql`${conversations.messageCount} + ${messages.length}`,
          userMessageCount: sql`${conversations.userMessageCount} + ${userCount}`,
          ...(latest ? { lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${latest.toISOString()}::timestamptz)` } : {}),
        })
        .where(eq(conversations.conversationId, conversationId));
    });
    // After the commit, so a reader woken by the signal sees the rows.
    notifyConversationChanged(conversationId);
  }

  /**
   * Get the most recent N messages for a conversation, ordered chronologically.
   *
   * Returns ModelMessage shape for direct use by the AI gateway. Reasoning is
   * NOT included here — Anthropic signed-block re-injection is handled by a
   * dedicated helper that consumes raw rows via `getHistorySnapshot()`.
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
   * The most recent `limit` rows of a conversation, oldest first, with the summary,
   * its `summary_through` marker and the persisted user-message count read in the
   * same statement, hence the same snapshot: `appendMessages` moves the rows and the
   * count in one transaction, so the count always lines up with the rows read and
   * the window can place the marker on them (history-window.ts).
   *
   * With `steps`, the replay columns (`steps`, `reasoning`) come back only for the
   * rows the window can hold, the exchanges after the marker (every row read when
   * the marker is 0, missing or past the count); older rows carry them as null. The
   * exchange count is the one `planHistoryWindow` uses: the stored count, or the
   * user rows read when more. Ordered like `getRecentMessages`, ties included.
   */
  async getHistorySnapshot(
    conversationId: string,
    limit: number,
    options: { steps?: boolean } = {},
  ): Promise<HistorySnapshot> {
    // In the window: fewer user rows after the row than the exchanges the marker leaves uncovered.
    const exchanges = sql`GREATEST(s.user_message_count, m.users_read)`;
    const inWindow = sql`m.users_after < CASE
        WHEN s.summary_through IS NULL OR s.summary_through <= 0 OR s.summary_through > ${exchanges} THEN ${limit}
        ELSE ${exchanges} - s.summary_through END`;
    const replayColumns = options.steps
      ? sql`CASE WHEN ${inWindow} THEN m.steps END AS steps, CASE WHEN ${inWindow} THEN m.reasoning END AS reasoning,`
      : sql``;
    const result = await db.execute(sql`
      SELECT m.role, m.content, m.created_at, ${replayColumns}
             -- The summary text rides on the newest row only: once, not once per row read.
             CASE WHEN m.rn = 1 THEN s.summary END AS summary, s.summary_through, s.user_message_count
      FROM (
        -- User rows among the rows read, counted after the LIMIT.
        SELECT r.*, count(*) FILTER (WHERE r.role = 'user') OVER () AS users_read
        FROM (
          SELECT role, content, created_at, ${options.steps ? sql`steps, reasoning,` : sql``}
                 row_number() OVER (ORDER BY created_at DESC) AS rn,
                 count(*) FILTER (WHERE role = 'user')
                   OVER (ORDER BY created_at DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS users_after
          FROM conversation_messages
          WHERE conversation_id = ${conversationId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        ) r
      ) m
      LEFT JOIN conversations s ON s.conversation_id = ${conversationId}
      ORDER BY m.rn DESC
    `);
    const raw = result as unknown as Array<Record<string, unknown>>;
    // As drizzle's jsonb mapper, a string cell (a legacy double-encoded value) is
    // parsed. One that is not JSON reads as null instead of failing the read or
    // passing a string as the declared type: that row replays its text only.
    const json = <T>(v: unknown): T | null => {
      if (v == null) return null;
      if (typeof v !== "string") return v as T;
      try {
        return JSON.parse(v) as T;
      } catch {
        return null;
      }
    };
    // Rows come oldest first; the newest carries the summary text (see the CASE above).
    const newest = raw[raw.length - 1];
    return {
      rows: raw.map((r) => ({
        role: r.role as string,
        content: r.content as string,
        ...(options.steps
          ? { steps: json<StepDetail[]>(r.steps), reasoning: json<ReasoningDetail[]>(r.reasoning) }
          : {}),
        createdAt: r.created_at ? new Date(r.created_at as string) : null,
      })),
      summary: (newest?.summary as string | null | undefined) ?? null,
      summaryThrough: newest?.summary_through == null ? null : Number(newest.summary_through),
      userMessageCount: newest?.user_message_count == null ? null : Number(newest.user_message_count),
    };
  }

  /**
   * Full-text search across conversation messages.
   *
   * `scope` is required and ANDed, which it was not: with `instanceId` absent
   * this search ran over `conversation_messages` joined to every conversation in
   * the deployment, so one tenant's query matched another tenant's message text.
   */
  async searchByKeyword(
    scope: TenantScope,
    query: string,
    instanceId?: InstanceSlug,
    limit = 20,
  ): Promise<KeywordSearchResult[]> {
    // Build the tsquery from the user query (websearch syntax handles natural language)
    const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;

    // Join with conversations to filter by instanceId if provided
    const instanceFilter = instanceId
      ? sql`AND c.instance_id = ${instanceId}`
      : sql``;
    const orgFilter = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");

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
        ${orgFilter}
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
    /** Case-insensitive substring of the contact (email, phone number, channel handle). */
    userIdentifier?: string;
    updatedSince?: Date;
    updatedUntil?: Date;
    limit?: number;
    offset?: number;
    scope: TenantScope;
  }): Promise<{ conversations: ConversationListItem[]; total: number }> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;

    const conditions: ReturnType<typeof sql>[] = [];
    if (options.instanceId) conditions.push(sql`c.instance_id = ${options.instanceId}`);
    if (options.source) conditions.push(sql`c.source = ${options.source}`);
    if (options.userIdentifier) {
      conditions.push(sql`c.user_identifier ILIKE ${`%${escapeLikePattern(options.userIdentifier)}%`}`);
    }
    if (options.updatedSince) conditions.push(sql`c.updated_at >= ${options.updatedSince.toISOString()}::timestamptz`);
    if (options.updatedUntil) conditions.push(sql`c.updated_at < ${options.updatedUntil.toISOString()}::timestamptz`);
    // Cross-org gate: an aggregate list (no instanceId) returns only caller-org
    // rows; a foreign-org instanceId param yields zero rows (ANDed at the store).
    // Applied UNCONDITIONALLY, and the scope is required: there is no absent
    // branch left to fall through to an unfiltered cross-org listing.
    conditions.push(tenantScopedAgentCondition(options.scope, "c.instance_id"));
    const instanceFilter = conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

    const [rows, countResult] = await Promise.all([
      // message_count is the conversation's own counter (migration
      // conversation_message_counters); a
      // fan-out join over conversation_messages would force Postgres to
      // aggregate the whole messages table before ORDER BY/LIMIT.
      db.execute(sql`
        SELECT
          c.id,
          c.conversation_id,
          c.title,
          c.summary,
          c.channel,
          c.user_identifier,
          c.instance_id,
          i.name AS instance_name,
          c.message_count AS message_count,
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
                 SUM(al.estimated_cost_usd::float8) AS total_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
                 SUM(al.estimated_cost_usd::float8) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
                 SUM(al.estimated_cost_usd::float8) FILTER (WHERE al.call_type = 'service') AS service_cost,
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
        title: displayTitle(r.title as string | null),
        summary: (r.summary as string) ?? null,
        channel: (r.channel as string) ?? null,
        userIdentifier: (r.user_identifier as string) ?? null,
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
   * @param scope the tenant this lookup acts in. REQUIRED: an internal caller
   *   that runs outside any request says so with `allTenantsScope(reason)`,
   *   which is a sentence review can disagree with, rather than by omitting an
   *   argument and inheriting whatever the absent branch happened to do.
   */
  async getConversation(
    conversationId: string,
    scope: TenantScope,
  ): Promise<ConversationDetail | null> {
    // Cross-org gate: scoping the lookup to the caller's org turns a foreign-org
    // conversation id into a "not found" (the controller maps null → 404).
    const orgFilter = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");
    const rows = await db.execute(sql`
      SELECT
        c.id,
        c.conversation_id,
        c.title,
        c.summary,
        c.channel,
        c.user_identifier,
        c.instance_id,
        i.name AS instance_name,
        c.message_count AS message_count,
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
               SUM(al.estimated_cost_usd::float8) AS total_cost,
               SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
               SUM(al.estimated_cost_usd::float8) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
               SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
               SUM(al.estimated_cost_usd::float8) FILTER (WHERE al.call_type = 'service') AS service_cost,
               SUM(al.cached_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cached_input_tokens,
               SUM(al.cache_creation_input_tokens) FILTER (WHERE al.call_type = 'conversation') AS cache_creation_input_tokens
        FROM ai_logs al
        WHERE al.conversation_id = c.conversation_id
      ) al_agg ON true
      WHERE c.conversation_id = ${conversationId} ${orgFilter}
    `);

    const r = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!r) return null;

    return {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      title: displayTitle(r.title as string | null),
      summary: (r.summary as string) ?? null,
      channel: (r.channel as string) ?? null,
      userIdentifier: (r.user_identifier as string) ?? null,
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
        // The bucket is storage configuration, read only by the deletes.
        attachments:
          (r.attachments as AttachmentMeta[] | null)?.map(({ bucket: _bucket, ...attachment }) => attachment) ?? null,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
        createdAt: r.createdAt ?? null,
      })),
      total: countResult[0]?.total ?? 0,
    };
  }

  /**
   * Fetch the heavy per-turn debug data for a single message: the captured LLM
   * request payload (DEBUG mode only), the multi-step tool trace, how the turn
   * arrived (channel, streaming, speech-to-text) and the model calls it made.
   * Scoped by conversationId so a message id cannot be read out of its
   * conversation. Returns null when the message does not exist in that conversation.
   */
  async getMessageDebug(conversationId: string, messageId: string): Promise<MessageDebug | null> {
    const rows = await db
      .select({
        debugPayload: conversationMessages.debugPayload,
        steps: conversationMessages.steps,
        createdAt: conversationMessages.createdAt,
      })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.conversationId, conversationId)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    // `ai_logs` has no message id, so the turn's calls are the conversation's
    // calls from the user message that opened the turn up to the next one:
    // the calls that answered it and the post-response ones after it.
    // An ISO string cast in SQL: the raw fragments below do not serialize a Date.
    const at = sql`${(row.createdAt ?? new Date()).toISOString()}::timestamptz`;
    const turnStart = sql`COALESCE((
      SELECT MAX(${conversationMessages.createdAt}) FROM ${conversationMessages}
      WHERE ${conversationMessages.conversationId} = ${conversationId}
        AND ${conversationMessages.role} = 'user' AND ${conversationMessages.createdAt} <= ${at}
    ), ${at})`;
    const turnEnd = sql`COALESCE((
      SELECT MIN(${conversationMessages.createdAt}) FROM ${conversationMessages}
      WHERE ${conversationMessages.conversationId} = ${conversationId}
        AND ${conversationMessages.role} = 'user' AND ${conversationMessages.createdAt} > ${at}
    ), 'infinity'::timestamptz)`;

    const [traces, calls] = await Promise.all([
      db
        .select({
          channel: pipelineTraces.channel,
          isStreaming: pipelineTraces.isStreaming,
          sttProvider: pipelineTraces.sttProvider,
          sttDurationMs: pipelineTraces.sttDurationMs,
          audioDurationSec: pipelineTraces.audioDurationSec,
        })
        .from(pipelineTraces)
        .where(and(eq(pipelineTraces.messageId, messageId), eq(pipelineTraces.conversationId, conversationId)))
        .limit(1),
      db
        .select({
          callType: aiLogs.callType,
          provider: aiLogs.provider,
          model: aiLogs.model,
          durationMs: aiLogs.durationMs,
          promptTokens: aiLogs.promptTokens,
          completionTokens: aiLogs.completionTokens,
          costUsd: aiLogs.estimatedCostUsd,
          outcome: aiLogs.outcome,
          errorKind: aiLogs.errorKind,
          createdAt: aiLogs.createdAt,
        })
        .from(aiLogs)
        .where(
          and(
            eq(aiLogs.conversationId, conversationId),
            sql`${aiLogs.createdAt} >= ${turnStart}`,
            sql`${aiLogs.createdAt} < ${turnEnd}`,
          ),
        )
        .orderBy(asc(aiLogs.createdAt)),
    ]);

    const trace = traces[0];
    return {
      debugPayload: (row.debugPayload as LlmDebugPayload | null) ?? null,
      steps: (row.steps as StepDetail[] | null) ?? null,
      turn: trace
        ? {
            channel: trace.channel,
            streaming: trace.isStreaming,
            // Only a voice turn has a transcription.
            speechToText:
              trace.sttProvider != null
                ? {
                    provider: trace.sttProvider,
                    durationMs: trace.sttDurationMs ?? null,
                    audioDurationSec: trace.audioDurationSec != null ? Number(trace.audioDurationSec) : null,
                  }
                : null,
          }
        : null,
      modelCalls: calls.map((c) => ({ ...c, createdAt: c.createdAt?.toISOString() ?? null })),
    };
  }

  /**
   * Search conversations by message content (FTS), by conversation id or by
   * contact substring (case-insensitive). Returns conversation-level results.
   */
  async searchConversations(
    query: string,
    options: { scope: TenantScope; instanceId?: InstanceSlug; userIdentifier?: string; limit?: number; offset?: number },
  ): Promise<{ conversations: ConversationSearchResult[]; total: number }> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
    const idPattern = `%${escapeLikePattern(query)}%`;

    // Cross-org gate: a search with no instanceId stays scoped to the caller-org
    // rows; a foreign-org instanceId param yields zero rows.
    const orgFilter = buildOrgScopedAgentFilterFragment(options.scope, "c.instance_id");
    const contactFilter = options.userIdentifier
      ? sql`AND c.user_identifier ILIKE ${`%${escapeLikePattern(options.userIdentifier)}%`}`
      : sql``;
    const instanceFilter = options.instanceId
      ? sql`AND c.instance_id = ${options.instanceId} ${orgFilter} ${contactFilter}`
      : sql`${orgFilter} ${contactFilter}`;

    const matchFilter = sql`(
      c.conversation_id ILIKE ${idPattern}
      OR c.user_identifier ILIKE ${idPattern}
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
          c.user_identifier,
          c.instance_id,
          i.name AS instance_name,
          COUNT(cm.id)::int AS match_count,
          (SELECT cm2.content FROM conversation_messages cm2
           WHERE cm2.conversation_id = c.conversation_id
             AND cm2.search_vector @@ ${tsQuery}
           ORDER BY ts_rank(cm2.search_vector, ${tsQuery}) DESC
           LIMIT 1
          ) AS best_snippet,
          c.message_count AS message_count,
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
                 SUM(al.estimated_cost_usd::float8) AS total_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'conversation') AS conversation_tokens,
                 SUM(al.estimated_cost_usd::float8) FILTER (WHERE al.call_type = 'conversation') AS conversation_cost,
                 SUM(al.total_tokens) FILTER (WHERE al.call_type = 'service') AS service_tokens,
                 SUM(al.estimated_cost_usd::float8) FILTER (WHERE al.call_type = 'service') AS service_cost,
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
        title: displayTitle(r.title as string | null),
        summary: (r.summary as string) ?? null,
        channel: (r.channel as string) ?? null,
        userIdentifier: (r.user_identifier as string) ?? null,
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
          cacheCreation5mInputTokens: pipelineTraces.cacheCreation5mInputTokens,
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
          cacheCreation5mInputTokens: trace.cacheCreation5mInputTokens ?? null,
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
        .select({ id: conversationMessages.id, role: conversationMessages.role })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(conversationMessages.createdAt)
        .limit(messageCount);

      if (oldest.length === 0) return;

      const idsToDelete = oldest.map((r) => r.id);
      const deletedUser = oldest.filter((r) => r.role === "user").length;

      await tx.delete(conversationMessages).where(inArray(conversationMessages.id, idsToDelete));
      const [summaryRow] = await tx.insert(conversationMessages).values({
        conversationId,
        role: "system",
        content: `[Room history summary]\n${summary}`,
      }).returning({ createdAt: conversationMessages.createdAt });
      // Keep the message counters exact: N rows out, one summary in.
      await tx
        .update(conversations)
        .set({
          messageCount: sql`${conversations.messageCount} - ${idsToDelete.length} + 1`,
          userMessageCount: sql`${conversations.userMessageCount} - ${deletedUser}`,
          // The summary marker counts user rows too: keep it on the same exchanges.
          summaryThrough: sql`CASE WHEN ${conversations.summaryThrough} IS NULL THEN NULL ELSE GREATEST(${conversations.summaryThrough} - ${deletedUser}, 0) END`,
          ...(summaryRow?.createdAt
            ? { lastMessageAt: sql`GREATEST(${conversations.lastMessageAt}, ${summaryRow.createdAt.toISOString()}::timestamptz)` }
            : {}),
        })
        .where(eq(conversations.conversationId, conversationId));
    });
  }

  /** Delete a conversation and all its messages (atomic). */
  /**
   * Whether this conversation belongs to the given tenant, decided INSIDE the
   * caller's transaction and under a row lock.
   *
   * The mutations below key every statement on `conversation_id` alone, across
   * nine tables. Their safety used to rest entirely on the controller having run
   * `loadConversationScoped` a few lines earlier: an ordering no type checked, no
   * test pinned, and no second caller inherited — the reset hook calls
   * `renameConversation` without it. The check belongs where the rows are, so
   * that forgetting it is not something a caller can do.
   *
   * `for update` matters: without the lock a concurrent rename could move the row
   * between this check and the statements that follow it.
   */
  private async conversationInTenant(
    tx: DbTransaction,
    conversationId: string,
    scope: TenantScope,
  ): Promise<boolean> {
    const tenantFilter = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");
    const rows = await tx.execute(sql`
      select 1
      from conversations c
      where c.conversation_id = ${conversationId} ${tenantFilter}
      for update
    `);
    return (rows as unknown as Array<Record<string, unknown>>).length > 0;
  }

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
    scope: TenantScope,
    title?: string,
  ): Promise<boolean> {
    const idChanged = newConversationId !== conversationId;
    return db.transaction(async (tx) => {
      if (!(await this.conversationInTenant(tx, conversationId, scope))) return false;
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

      // The cache is keyed by the id — drop stale entries for both old and new.
      this.titleCache.delete(conversationId);
      this.titleCache.delete(newConversationId);

      return result.length > 0;
    });
  }

  async deleteConversation(conversationId: string, scope: TenantScope): Promise<boolean> {
    return db.transaction(async (tx) => {
      if (!(await this.conversationInTenant(tx, conversationId, scope))) return false;
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

      this.titleCache.delete(conversationId);
      return result.length > 0;
    });
  }
}

export const conversationStore = new ConversationStore();
