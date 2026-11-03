// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, lte, lt, or, isNull, notInArray, inArray, count, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { scheduledTasks, type ScheduledTask, type ScheduleConfig } from "./schema.js";
import { computeNextRun, computeRetryDelay, MAX_CONSECUTIVE_ERRORS } from "./schedule-utils.js";
import { type InstanceSlug } from "../instances/identifiers.js";

export interface CreateTaskInput {
  instanceId: InstanceSlug;
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
  /**
   * Defaults to true. Pass false to create a task that exists but does not fire,
   * so a schedule can be reviewed before it starts writing to a live system —
   * previously only reachable as create-then-disable, which leaves a window in
   * which the cron can tick.
   */
  enabled?: boolean;
  /** Per-run deadline in ms; null/undefined → the platform's default deadline. */
  maxRunMs?: number | null;
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
  maxRunMs?: number | null;
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
  instanceId: InstanceSlug,
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
      enabled: input.enabled ?? true,
      maxRunMs: input.maxRunMs ?? null,
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
  if (input.maxRunMs !== undefined) sets.maxRunMs = input.maxRunMs;

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

/**
 * Due for execution: enabled, not running, `next_run_at` reached, and the parent
 * instance active. The instance join is a security guard: an operator disabling an
 * instance immediately silences its scheduled jobs without touching the `enabled` flag
 * on each task.
 */
function dueAt(now: Date) {
  return and(
    eq(scheduledTasks.enabled, true),
    eq(instances.status, "active"),
    lte(scheduledTasks.nextRunAt, now),
    or(isNull(scheduledTasks.lastRunStatus), sql`${scheduledTasks.lastRunStatus} != 'running'`),
  );
}

/** How many tasks are due at `now`. For the warning when no slot is free. */
export async function countDueTasks(now: Date): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(scheduledTasks)
    .innerJoin(instances, eq(instances.slug, scheduledTasks.instanceId))
    .where(dueAt(now));
  return rows[0]?.n ?? 0;
}

/** A run lease expiry `ttlMs` from now, on the database clock. */
const leaseUntil = (ttlMs: number) => sql`now() + ${ttlMs} * interval '1 millisecond'`;

/**
 * Claim up to `limit` due tasks in one statement, the longest overdue first, and
 * return them; their claim is `now`. Rows another replica is claiming at the same
 * moment are skipped rather than waited for, so replicas ticking together share the
 * due tasks instead of contending for the same few. `skip` names the tasks still
 * executing in this process (see the in-process guard in the scheduler).
 */
export async function claimDueTasks(
  now: Date,
  limit: number,
  opts: { leaseTtlMs: number; skip: string[] },
): Promise<ScheduledTask[]> {
  const due = db
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .innerJoin(instances, eq(instances.slug, scheduledTasks.instanceId))
    .where(and(dueAt(now), opts.skip.length > 0 ? notInArray(scheduledTasks.id, opts.skip) : undefined))
    .orderBy(scheduledTasks.nextRunAt)
    .limit(limit)
    .for("update", { of: scheduledTasks, skipLocked: true });
  return db
    .update(scheduledTasks)
    .set({ lastRunStatus: "running", lastRunAt: now, updatedAt: now, leaseExpiresAt: leaseUntil(opts.leaseTtlMs) })
    .where(inArray(scheduledTasks.id, due))
    .returning();
}

/**
 * The identity of one claim on a task: the `last_run_at` its `markRunning` wrote.
 *
 * `running` alone cannot tell two runs apart. After the reaper fails an overrunning
 * run A, another replica can claim the task for run B; A's late completion would then
 * match B's `running` row, clear B's claim and, with `deleteAfterRun`, delete the task
 * under it. Every write that ends a run therefore names the claim it ends. `last_run_at`
 * carries it because nothing else writes that column while a run is live (an API edit
 * moves `updated_at`, which would make a live run lose its own completion).
 *
 * `null` is the claim of a row marked `running` by a process that did not stamp it,
 * read back as-is by the reaper.
 */
export type RunClaim = Date | null;

/** Millisecond precision on both sides: the claim is written from a JS Date. */
function isClaim(claim: RunClaim) {
  return claim === null
    ? isNull(scheduledTasks.lastRunAt)
    : sql`date_trunc('milliseconds', ${scheduledTasks.lastRunAt}) = ${claim.toISOString()}::timestamptz`;
}

/**
 * Atomically mark a task as running, for a manual run. Returns the claim, or `null`
 * when another run holds the task.
 */
export async function markRunning(id: string, opts: { leaseTtlMs: number }): Promise<Date | null> {
  const claim = new Date();
  const result = await db
    .update(scheduledTasks)
    .set({ lastRunStatus: "running", lastRunAt: claim, updatedAt: claim, leaseExpiresAt: leaseUntil(opts.leaseTtlMs) })
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

  return result.length > 0 ? claim : null;
}

/**
 * Extend the lease of the run holding `claim`. False when the run no longer holds the
 * task. The run's start (`updated_at`) is left alone: the reaper's deadline counts from it.
 */
export async function renewRunLease(id: string, claim: RunClaim, leaseTtlMs: number): Promise<boolean> {
  const rows = await db
    .update(scheduledTasks)
    .set({ leaseExpiresAt: leaseUntil(leaseTtlMs) })
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.lastRunStatus, "running"), isClaim(claim)))
    .returning({ id: scheduledTasks.id });
  return rows.length > 0;
}

/**
 * Mark the run holding `claim` as successfully completed. Returns the completion
 * time, or `null` when that claim no longer holds the task (see `RunClaim`).
 */
export async function markCompleted(id: string, conversationId: string, claim: RunClaim): Promise<Date | null> {
  const task = await getById(id);
  if (!task) return null;

  const schedule = task.schedule as ScheduleConfig;
  const now = new Date();
  const nextRunAt = computeNextRun(schedule, now);

  const rows = await db
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
      leaseExpiresAt: null,
    })
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.lastRunStatus, "running"), isClaim(claim)))
    .returning({ id: scheduledTasks.id });
  return rows.length > 0 ? now : null;
}

/**
 * Delete a one-shot task after the run that completed at `completedAt`, and only if
 * nothing has claimed or completed it since. Returns whether the row was deleted.
 */
export async function removeAfterRun(id: string, completedAt: Date): Promise<boolean> {
  const rows = await db
    .delete(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.lastRunStatus, "success"), isClaim(completedAt)))
    .returning({ id: scheduledTasks.id });
  return rows.length > 0;
}

/**
 * Mark the run holding `claim` as failed. Returns whether the row was updated.
 *
 * The write is a compare-and-set on the claim it was read for (see `RunClaim`). The
 * reaper passes the claim it saw: between that read and this write, the run it judged
 * overdue may have completed and the task been claimed again by another replica (the
 * in-process guard in the scheduler only sees its own process), and failing THAT run
 * would overwrite a live claim and free it for a third execution.
 */
export async function markFailed(id: string, error: string, claim: RunClaim): Promise<boolean> {
  const task = await getById(id);
  if (!task) return false;

  const newConsecutive = task.consecutiveErrors + 1;
  const schedule = task.schedule as ScheduleConfig;
  const now = new Date();

  // A stored schedule no next run can be computed from (written before the writers
  // validated it) disables the task: retrying it would fail the same way.
  let scheduledNext: Date | null = null;
  let scheduleBroken = false;
  try {
    scheduledNext = computeNextRun(schedule, now);
  } catch {
    scheduleBroken = true;
  }
  const shouldDisable = scheduleBroken || newConsecutive >= MAX_CONSECUTIVE_ERRORS;

  // For retries, use backoff delay; otherwise the normal next run
  let nextRunAt: Date | null;
  if (shouldDisable) {
    nextRunAt = null;
  } else if (newConsecutive <= task.maxRetries) {
    // Retry with backoff
    nextRunAt = new Date(now.getTime() + computeRetryDelay(newConsecutive - 1));
  } else {
    // Past max retries for this run, advance to normal next schedule
    nextRunAt = scheduledNext;
  }

  const rows = await db
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
      leaseExpiresAt: null,
    })
    .where(and(
      eq(scheduledTasks.id, id),
      eq(scheduledTasks.lastRunStatus, "running"),
      isClaim(claim),
    ))
    .returning({ id: scheduledTasks.id });
  return rows.length > 0;
}

/**
 * Tasks stuck in `running` since before `since`, oldest first.
 *
 * `updated_at` is the run's start time while the row is `running`: `markRunning` is the
 * last write before the run, and `markCompleted`/`markFailed` are the next ones. A write
 * from elsewhere mid-run (an API edit, say) only pushes the timestamp forward, which
 * DELAYS recovery — the safe direction to be wrong in, since the opposite would recover a
 * run that is still alive.
 */
export async function findStuckRunning(since: Date): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.lastRunStatus, "running"), lt(scheduledTasks.updatedAt, since)))
    .orderBy(scheduledTasks.updatedAt);
}

/** How many rows are currently stuck in `running` since before `since`. For metrics. */
export async function countStuckRunning(since: Date): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.lastRunStatus, "running"), lt(scheduledTasks.updatedAt, since)));
  return rows[0]?.n ?? 0;
}

/**
 * Running rows whose lease has expired: the process running them stopped renewing it,
 * so it is gone (or cannot reach the database). A row claimed without a lease is left
 * to the deadline reaper.
 */
export async function findExpiredRunLeases(): Promise<ScheduledTask[]> {
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.lastRunStatus, "running"), lt(scheduledTasks.leaseExpiresAt, sql`now()`)))
    .orderBy(scheduledTasks.updatedAt);
}

/**
 * Clear the `running` marker so the task is due again, WITHOUT touching the error
 * counters or `nextRunAt`.
 *
 * Used for a run whose lease expired: a run interrupted by a deploy or a crash is not
 * the task's fault, so it must not consume a retry, count towards
 * `MAX_CONSECUTIVE_ERRORS`, or push the next run into the future. The interrupted run
 * itself is closed in the run log as an error — the audit says what happened, the
 * schedule carries on as if the tick had not fired.
 *
 * Each row is matched on the claim the recovery READ, not on `running` alone: between the
 * read and this write the interrupted run may have been closed and a new run B claimed
 * the task, and clearing B's marker would let the next tick start the task a second time
 * while B is still live. A row whose claim moved on is left alone.
 */
export async function clearRunningMarker(
  observed: Array<{ id: string; claim: RunClaim }>,
): Promise<string[]> {
  if (observed.length === 0) return [];
  const rows = await db
    .update(scheduledTasks)
    .set({ lastRunStatus: null, updatedAt: new Date(), leaseExpiresAt: null })
    .where(and(
      eq(scheduledTasks.lastRunStatus, "running"),
      or(...observed.map(({ id, claim }) => and(eq(scheduledTasks.id, id), isClaim(claim)))),
    ))
    .returning({ id: scheduledTasks.id });
  return rows.map((row) => row.id);
}

/** Disable a task */
export async function disableTask(id: string): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(scheduledTasks.id, id));
}
