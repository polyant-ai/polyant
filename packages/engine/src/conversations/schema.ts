// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, json, jsonb, index, primaryKey, integer, bigint } from "drizzle-orm/pg-core";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: text("conversation_id").notNull().unique(),
    summary: text("summary"),
    title: text("title"),
    instanceId: text("instance_id"),
    channel: text("channel").default("web"),
    source: text("source").default("user"),
    userIdentifier: text("user_identifier"),
    contextPrompt: text("context_prompt"),
    // created_at of the last message `summary` covers: the turn's history starts
    // right after it, so summary and history meet with no gap (migration 0102).
    summaryThrough: timestamp("summary_through", { withTimezone: true }),
    // created_at of the last message memory extraction read before it was kept by
    // seq; read only while `memoryThroughSeq` is NULL.
    memoryThrough: timestamp("memory_through", { withTimezone: true }),
    // seq of the last message memory extraction has read (migration 0117).
    memoryThroughSeq: bigint("memory_through_seq", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // Kept by ConversationStore.appendMessages in the statement that bumps
    // updated_at, so lists and analytics read them instead of counting
    // conversation_messages per conversation (migration conversation_message_counters).
    messageCount: integer("message_count").notNull().default(0),
    userMessageCount: integer("user_message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_conversations_instance_created").on(table.instanceId, table.createdAt),
    // Conversation list: each agent's page, in the list's order (id breaks ties).
    index("idx_conversations_instance_updated_id").on(table.instanceId, table.updatedAt.desc().nullsLast(), table.id.desc()),
    // Message-level analytics: the tenant's conversations active in a window.
    index("idx_conversations_instance_last_message").on(table.instanceId, table.lastMessageAt),
  ],
);

/** Metadata stored per-attachment in the JSONB column (no binary data — only references). */
export interface AttachmentMeta {
  type: "image" | "file" | "audio" | "video";
  mimeType?: string;
  fileName?: string;
  /** Platform S3 key where the file is stored. */
  s3Key: string;
  /**
   * The bucket the file was written to. The agent's bucket can change later,
   * and a delete must reach the file where it is. Absent on files stored
   * before it was recorded. Kept out of API responses.
   */
  bucket?: string;
  sizeBytes?: number;
}

/**
 * Reasoning/thinking detail emitted by a model. Mirrors the Vercel AI SDK v4
 * `ReasoningDetail` shape, with the addition of an Anthropic-only `signature`
 * for signed thinking blocks (required for multi-turn re-injection).
 */
export type ReasoningDetail =
  | { type: "text"; text: string; signature?: string }
  | { type: "redacted"; data: string };

/**
 * One step of a multi-step tool-using turn. The Vercel AI SDK runs an internal
 * loop where the model can call tools, observe results, and continue. Each
 * iteration is a step. Persisting one StepDetail per step gives us full
 * timeline fidelity for replay and UI rendering.
 *
 * `legacy: true` marks rows backfilled from the old `tool_calls` column shape
 * (no real timing or reasoning data — synthesised from {toolName, args, result}
 * triples).
 */
export interface StepDetail {
  index: number;
  stepType: "initial" | "continue" | "tool-result";
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults?: { toolCallId: string; result: unknown }[];
  reasoning?: ReasoningDetail[];
  finishReason: string;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * This step's cache reads, cache writes and their 5-minute share: subsets of
   * `promptTokens`, recorded when the provider reports them. A step is one model
   * call, which is the unit a model priced by prompt length is billed on.
   */
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  /** The provider reported that this step's model call ran in fast mode. */
  fast?: boolean;
  durationMs: number;
  legacy?: boolean;
}

/**
 * Exact LLM request payload captured for an assistant turn when the instance's
 * `debug_enabled` flag is on. Heavy and PII-bearing at rest — persisted only
 * opt-in (see pipeline `afterResponse`). The per-step tool I/O lives in `steps`
 * and is NOT duplicated here.
 */
export interface LlmDebugPayload {
  /** Full system prompt string sent to the model. */
  system: string;
  /** The messages array (ModelMessage[]) sent to the model, serialized. */
  messages: unknown[];
  /** Tool definitions sent to the model (best-effort name + description + JSON schema). */
  tools: { name: string; description?: string; parameters?: unknown }[];
}

/**
 * The messages one row contributed to a model request, exactly as they were
 * sent, kept for agents that replay their history exactly (`tool_history_replay
 * = 'exact'`). A user row holds the user message with its content parts (the
 * volatile `<context>` tail included); an assistant row holds the turn's
 * step-by-step assistant and tool messages (the AI SDK's response messages).
 */
export interface ExactReplay {
  /** AI SDK `ModelMessage`s, in the order they were sent. */
  messages: unknown[];
  /**
   * Assistant rows: a fingerprint of the system prompt, tool set and model the
   * turn ran with. A replayed thinking block is bound to that prefix, so its
   * reasoning is dropped once the fingerprint no longer matches the request.
   */
  prefixKey?: string;
}

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: text("conversation_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    /**
     * Multi-step tool loop, persisted granularly. NULL for user/system messages.
     *
     * Schema migration 0038 renamed the legacy `tool_calls jsonb` column to
     * `steps` and reshaped the payload from `[{toolName, args, result}]` to
     * `StepDetail[]`. Legacy rows are backfilled with `legacy: true`.
     */
    steps: jsonb("steps").$type<StepDetail[]>(),
    /**
     * Aggregated reasoning at the message level — used for UI rendering and
     * for re-injecting Anthropic signed thinking blocks in multi-turn flows.
     * Per-step reasoning is also kept inside `steps[i].reasoning` for replay.
     */
    reasoning: jsonb("reasoning").$type<ReasoningDetail[]>(),
    attachments: jsonb("attachments").$type<AttachmentMeta[]>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    /**
     * Exact LLM request payload (system + messages + tool defs) for this assistant
     * turn. NULL unless the instance had `debug_enabled` on when it was generated.
     * Heavy / PII at rest — never selected by the default `getMessages` list query;
     * fetched on-demand via the per-message debug endpoint.
     */
    debugPayload: jsonb("debug_payload").$type<LlmDebugPayload>(),
    /**
     * The row's messages as sent to the model (see `ExactReplay`). NULL unless the
     * agent replays its history exactly. `json`, not `jsonb`: jsonb reorders object
     * keys, and a tool input re-serialized in another key order is another prefix.
     */
    exactReplay: json("exact_replay").$type<ExactReplay>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /**
     * The order the rows were saved in, which created_at (a message's arrival)
     * is not when two turns overlap. Filled by the database from the sequence
     * migration 0117 sets as the column default; never written by the engine.
     * NULL on rows saved before that migration.
     */
    seq: bigint("seq", { mode: "number" }),
  },
  (table) => [
    index("idx_conversation_messages_created_at").on(table.createdAt),
    // One conversation's messages in time order (history reads, windowed scans).
    index("idx_conversation_messages_conversation_created").on(table.conversationId, table.createdAt),
    // The messages people sent, answered from the index (the weekday-and-hour distribution).
    index("idx_conversation_messages_user_created")
      .on(table.conversationId, table.createdAt)
      .where(sql`${table.role} = 'user'`),
    // The daily cleanup clears old debug payloads (analytics/cleanup.ts).
    index("idx_conversation_messages_debug_created").on(table.createdAt).where(sql`${table.debugPayload} IS NOT NULL`),
  ],
);

/**
 * Per-conversation shared key/value state ("conversation state store").
 *
 * A single JSONB blob per scope that every tool can read/write via `ctx.state`,
 * plus a server-seeded `_channel` key holding the trusted channel identity
 * (phone / chat id / userName). Writes are deterministic — tool code only, never
 * the LLM — and committed on pipeline success (see `state.buffer.ts`).
 *
 * `scope` / `scopeKey` are an abstraction: today only `scope = "conversation"`
 * is used (`scopeKey` = conversationId). A future "principal" tier can be added
 * without a schema change. `instanceId` is the denormalized slug, kept only for
 * the instance-delete cascade — operational/PII tier (slug-text, no UUID FK).
 */
export const conversationState = pgTable(
  "conversation_state",
  {
    scope: text("scope").notNull().default("conversation"),
    scopeKey: text("scope_key").notNull(),
    instanceId: text("instance_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.scopeKey] }),
    index("idx_conversation_state_scope_key").on(table.scopeKey),
    index("idx_conversation_state_instance").on(table.instanceId),
  ],
);
