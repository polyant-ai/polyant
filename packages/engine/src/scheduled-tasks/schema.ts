// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, timestamp, boolean, integer, jsonb, index } from "drizzle-orm/pg-core";

// --- Schedule config types ---

export type CronSchedule = { type: "cron"; expression: string; timezone?: string };
export type IntervalSchedule = { type: "interval"; everyMs: number; anchorAt?: string };
export type OneShotSchedule = { type: "one-shot"; runAt: string };

export type ScheduleConfig = CronSchedule | IntervalSchedule | OneShotSchedule;

export type TaskRunStatus = "success" | "error" | "running";

// --- DB table ---

export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: text("agent_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),

    /** Discriminated union: { type: "cron" | "interval" | "one-shot", ... } */
    schedule: jsonb("schedule").$type<ScheduleConfig>().notNull(),

    /** The user-message prompt sent when the task fires */
    prompt: text("prompt").notNull(),

    // --- State tracking ---
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: varchar("last_run_status", { length: 20 }).$type<TaskRunStatus>(),
    lastError: text("last_error"),
    lastConversationId: text("last_conversation_id"),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    totalRuns: integer("total_runs").notNull().default(0),

    // --- Outbound notification ---
    outboundChannel: varchar("outbound_channel", { length: 50 }),
    outboundTarget: text("outbound_target"),

    // --- Behavior ---
    keepHistory: boolean("keep_history").notNull().default(false),
    deleteAfterRun: boolean("delete_after_run").notNull().default(false),
    maxRetries: integer("max_retries").notNull().default(3),

    // --- Metadata ---
    createdBy: text("created_by"), // "agent" | "api" | "admin"
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_scheduled_tasks_instance").on(table.instanceId),
    index("idx_scheduled_tasks_next_run").on(table.nextRunAt),
  ],
);

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;

// --- Run log types ---

export type RunStatus = "running" | "success" | "error";
export type TriggerType = "scheduled" | "manual";

export interface ToolCallEntry {
  name: string;
  args?: Record<string, unknown>;
  durationMs?: number;
}

export interface TokenUsageEntry {
  promptTokens?: number;
  completionTokens?: number;
}

// --- Run log table ---

export const scheduledTaskRuns = pgTable(
  "scheduled_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => scheduledTasks.id, { onDelete: "cascade" }),
    instanceId: text("agent_id").notNull(),
    status: varchar("status", { length: 20 }).$type<RunStatus>().notNull(),
    triggerType: varchar("trigger_type", { length: 20 }).$type<TriggerType>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    output: text("output"),
    error: text("error"),
    toolCalls: jsonb("tool_calls").$type<ToolCallEntry[]>().default([]),
    tokenUsage: jsonb("token_usage").$type<TokenUsageEntry>().default({}),
    conversationId: text("conversation_id"),
  },
  (table) => [
    index("idx_task_runs_instance_started").on(table.instanceId, table.startedAt),
    index("idx_task_runs_task_started").on(table.taskId, table.startedAt),
  ],
);

export type ScheduledTaskRun = typeof scheduledTaskRuns.$inferSelect;
export type NewScheduledTaskRun = typeof scheduledTaskRuns.$inferInsert;
