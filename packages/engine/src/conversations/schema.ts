// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, timestamp, jsonb, index, primaryKey } from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_conversations_instance_created").on(table.instanceId, table.createdAt),
  ],
);

/** Metadata stored per-attachment in the JSONB column (no binary data — only references). */
export interface AttachmentMeta {
  type: "image" | "file" | "audio" | "video";
  mimeType?: string;
  fileName?: string;
  /** Platform S3 key where the file is stored. */
  s3Key: string;
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
  durationMs: number;
  legacy?: boolean;
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_conversation_messages_conversation_id").on(table.conversationId),
    index("idx_conversation_messages_created_at").on(table.createdAt),
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
