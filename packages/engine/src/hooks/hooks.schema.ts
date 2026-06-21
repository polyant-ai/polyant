// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, boolean, integer, timestamp, jsonb, text, index } from "drizzle-orm/pg-core";
import { instances } from "../instances/schema.js";
import type { HookActionConfig } from "./hook-types.js";

/**
 * Per-instance lifecycle hooks: run an action (v1: a tool with template args)
 * when a conversation lifecycle event fires. See
 * docs/superpowers/specs/2026-06-10-hook-system-design.md.
 */
export const instanceHooks = pgTable(
  "agent_hooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("agent_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 32 }).notNull(),
    actionType: varchar("action_type", { length: 32 }).notNull().default("tool"),
    actionConfig: jsonb("action_config").$type<HookActionConfig>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    position: integer("position").notNull().default(0),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_instance_hooks_instance_event").on(table.instanceId, table.event),
  ],
);

/**
 * Per-execution telemetry for hooks, rendered in the conversation detail UI.
 * Slug-keyed (text columns, no FK) like pipeline_traces/tool_audit_logs:
 * rows survive hook deletion (historical record) and instance deletion, but are
 * dropped with their conversation (deleteConversation cascade).
 */
export const hookExecutions = pgTable(
  "hook_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: text("agent_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    /** The instance_hooks row that fired — intentionally NOT a FK (history outlives the hook). */
    hookId: uuid("hook_id").notNull(),
    event: varchar("event", { length: 32 }).notNull(),
    actionType: varchar("action_type", { length: 32 }).notNull(),
    toolName: text("tool_name").notNull(),
    success: boolean("success").notNull(),
    error: text("error"),
    durationMs: integer("duration_ms").notNull(),
    /** Rendered tool args (post-template). Same exposure class as message `steps`. */
    args: jsonb("args").$type<Record<string, unknown>>(),
    /** Tool result, JSON-stringified and truncated. */
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_hook_executions_conversation").on(table.conversationId, table.createdAt),
    index("idx_hook_executions_instance").on(table.instanceId),
  ],
);
