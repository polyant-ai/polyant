// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, lte, or, isNull, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { scheduledTasks, type ScheduledTask, type ScheduleConfig } from "./schema.js";
import { computeNextRun, computeRetryDelay, MAX_CONSECUTIVE_ERRORS } from "./schedule-utils.js";

export interface CreateTaskInput {
  instanceId: string;
  name: string;
  prompt: string;
  schedule: ScheduleConfig;
  description?: string;
  deleteAfterRun?: boolean;
  maxRetries?: number;
  createdBy?: string;
  outboundChannel?: string | null;
  outboundTarget?: string | null;
  keepHistory?: boolean;
}

export interface UpdateTaskInput {
  name?: string;
  description?: string;
  prompt?: string;
  schedule?: ScheduleConfig;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  maxRetries?: number;
  outboundChannel?: string | null;
  outboundTarget?: string | null;
  keepHistory?: boolean;
}

/** Options for `listByInstance`. All fields optional — defaults preserve the
 *  previous unbounded behaviour from the API's perspective except for the
 *  built-in `limit = 100` safety cap.
 *
 *  The cap is a defence against unbounded payloads on instances that
 *  accumulate many tasks (cron + one-shot). Callers that genuinely need to
 *  paginate the full set should pass `limit` + `offset` explicitly. The
 *  underlying ordering (`createdAt ASC`) is stable across pages. */
export interface ListByInstanceOptions {
  limit?: number;
  offset?: number;
  enabledOnly?: boolean;
}

/** Default cap applied when no `limit` is passed. Tuned to cover ~99% of
 *  realistic per-instance task counts while protecting against runaway
 *  payloads in tool responses and admin list pages. */
export const LIST_BY_INSTANCE_DEFAULT_LIMIT = 100;

/** List tasks for an instance, ordered by creation time ascending.
 *  Paginates with `limit` (default 100) + `offset` (default 0). The
 *  single-arg signature `listByInstance(slug)` is preserved for
 *  backward-compatibility — existing callers transparently pick up the
 *  default cap. */
export async function listByInstance(
  instanceId: string,
  options: ListByInstanceOptions = {},
): Promise<ScheduledTask[]> {
  const limit = options.limit ?? LIST_BY_INSTANCE_DEFAULT_LIMIT;
  const offset = options.offset ?? 0;

  const whereClause = options.enabledOnly
    ? and(eq(scheduledTasks.instanceId, instanceId), eq(scheduledTasks.enabled, true))
    : eq(scheduledTasks.instanceId, instanceId);

  return db
    .select()
    .from(scheduledTasks)
    .where(whereClause)
    .orderBy(scheduledTasks.createdAt)
    .limit(limit)
    .offset(offset);
}

/** Get a single task by ID */
export async function getById(id: string): Promise<ScheduledTask | undefined> {
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .limit(1);
  return rows[0];
}

/** Create a new scheduled task */
export async function create(input: CreateTaskInput): Promise<ScheduledTask> {
  const nextRunAt = computeNextRun(input.schedule);

  const rows = await db
    .insert(scheduledTasks)
    .values({
      instanceId: input.instanceId,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      description: input.description ?? null,
      deleteAfterRun: input.deleteAfterRun ?? false,
      maxRetries: input.maxRetries ?? 3,
      createdBy: input.createdBy ?? null,
      outboundChannel: input.outboundChannel ?? null,
      outboundTarget: input.outboundTarget ?? null,
      keepHistory: input.keepHistory ?? false,
      nextRunAt,
    })
    .returning();

  return rows[0];
}

/** Update an existing task (partial) */
export async function update(id: string, input: UpdateTaskInput): Promise<ScheduledTask | undefined> {
  const sets: Record<string, unknown> = { updatedAt: new Date() };

  if (input.name !== undefined) sets.name = input.name;
  if (input.description !== undefined) sets.description = input.description;
  if (input.prompt !== undefined) sets.prompt = input.prompt;
  if (input.enabled !== undefined) sets.enabled = input.enabled;
  if (input.deleteAfterRun !== undefined) sets.deleteAfterRun = input.deleteAfterRun;
  if (input.maxRetries !== undefined) sets.maxRetries = input.maxRetries;
  if (input.outboundChannel !== undefined) sets.outboundChannel = input.outboundChannel;
  if (input.outboundTarget !== undefined) sets.outboundTarget = input.outboundTarget;
  if (input.keepHistory !== undefined) sets.keepHistory = input.keepHistory;

  if (input.schedule !== undefined) {
    sets.schedule = input.schedule;
    sets.nextRunAt = computeNextRun(input.schedule);
  }

  // If re-enabling, reset error state and recompute next run
  if (input.enabled === true) {
    sets.consecutiveErrors = 0;
    sets.lastError = null;
    sets.lastRunStatus = null;
    // Recompute nextRunAt from current schedule if not already being changed
    if (input.schedule === undefined) {
      const existing = await getById(id);
      if (existing) {
        sets.nextRunAt = computeNextRun(existing.schedule as ScheduleConfig);
      }
    }
  }

  const rows = await db
    .update(scheduledTasks)
    .set(sets)
    .where(eq(scheduledTasks.id, id))
    .returning();

  return rows[0];
}

/** Delete a task */
export async function remove(id: string): Promise<void> {
  await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id));
}

/** Get all tasks that are due for execution.
 *
 *  Joins `instances` on slug and filters by `status = 'active'` so tasks whose
 *  parent instance is disabled never fire (security guard: an operator disabling
 *  an instance immediately silences its scheduled jobs without touching the
 *  `enabled` flag on each task). The join is non-N+1: a single SELECT per tick.
 */
export async function getDueTasks(now: Date): Promise<ScheduledTask[]> {
  const rows = await db
    .select({ task: scheduledTasks })
    .from(scheduledTasks)
    .innerJoin(instances, eq(instances.slug, scheduledTasks.instanceId))
    .where(
      and(
        eq(scheduledTasks.enabled, true),
        eq(instances.status, "active"),
        lte(scheduledTasks.nextRunAt, now),
        or(
          isNull(scheduledTasks.lastRunStatus),
          sql`${scheduledTasks.lastRunStatus} != 'running'`,
        ),
      ),
    );
  return rows.map((r) => r.task);
}

/** Atomically mark a task as running. Returns true if the update was applied (no race). */
export async function markRunning(id: string): Promise<boolean> {
  const result = await db
    .update(scheduledTasks)
    .set({ lastRunStatus: "running", updatedAt: new Date() })
    .where(
      and(
        eq(scheduledTasks.id, id),
        or(
          isNull(scheduledTasks.lastRunStatus),
          sql`${scheduledTasks.lastRunStatus} != 'running'`,
        ),
      ),
    )
    .returning({ id: scheduledTasks.id });

  return result.length > 0;
}

/** Mark a task as successfully completed */
export async function markCompleted(id: string, conversationId: string): Promise<void> {
  const task = await getById(id);
  if (!task) return;

  const schedule = task.schedule as ScheduleConfig;
  const now = new Date();
  const nextRunAt = computeNextRun(schedule, now);

  await db
    .update(scheduledTasks)
    .set({
      lastRunAt: now,
      lastRunStatus: "success",
      lastError: null,
      lastConversationId: conversationId,
      consecutiveErrors: 0,
      totalRuns: sql`${scheduledTasks.totalRuns} + 1`,
      nextRunAt,
      updatedAt: now,
    })
    .where(eq(scheduledTasks.id, id));
}

/** Mark a task as failed */
export async function markFailed(id: string, error: string): Promise<void> {
  const task = await getById(id);
  if (!task) return;

  const newConsecutive = task.consecutiveErrors + 1;
  const shouldDisable = newConsecutive >= MAX_CONSECUTIVE_ERRORS;

  const schedule = task.schedule as ScheduleConfig;
  const now = new Date();

  // For retries, use backoff delay; otherwise compute normal next run
  let nextRunAt: Date | null;
  if (shouldDisable) {
    nextRunAt = null;
  } else if (newConsecutive <= task.maxRetries) {
    // Retry with backoff
    nextRunAt = new Date(now.getTime() + computeRetryDelay(newConsecutive - 1));
  } else {
    // Past max retries for this run, advance to normal next schedule
    nextRunAt = computeNextRun(schedule, now);
  }

  await db
    .update(scheduledTasks)
    .set({
      lastRunAt: now,
      lastRunStatus: "error",
      lastError: error,
      consecutiveErrors: newConsecutive,
      totalRuns: sql`${scheduledTasks.totalRuns} + 1`,
      enabled: shouldDisable ? false : undefined,
      nextRunAt,
      updatedAt: now,
    })
    .where(eq(scheduledTasks.id, id));
}

/** Disable a task */
export async function disableTask(id: string): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(scheduledTasks.id, id));
}

/** Find an active task whose outbound matches the given channel + target for an instance.
 *  Used to detect if an incoming channel message is a reply to a scheduled task's output. */
export async function findActiveTaskByOutbound(
  instanceId: string,
  channelType: string,
  channelId: string,
): Promise<ScheduledTask | undefined> {
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.instanceId, instanceId),
        eq(scheduledTasks.outboundChannel, channelType),
        eq(scheduledTasks.outboundTarget, channelId),
        eq(scheduledTasks.enabled, true),
        eq(scheduledTasks.keepHistory, true),
        sql`${scheduledTasks.lastConversationId} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${scheduledTasks.lastRunAt} DESC NULLS LAST`)
    .limit(1);
  return rows[0];
}
