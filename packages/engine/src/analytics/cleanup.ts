// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Daily housekeeping for the tables that grow with traffic rather than with
 * configuration.
 *
 * Retention existed for exactly the two tables somebody had already watched grow
 * — `ai_logs` and `pipeline_traces`. Four more grow the same way and had no
 * policy at all: `tool_audit_logs` (one row per tool call, holding the tool's
 * arguments and its serialized output), `hook_executions` (one row per hook
 * firing), `scheduled_task_runs` (one row per run) and the completed half of
 * `event_backlog`. Those four are also what the heaviest analytics aggregations
 * read, so their unbounded growth is felt on the dashboard before it is felt on
 * disk.
 *
 * NOT included, deliberately: `conversation_messages`, `memories` and the
 * knowledge tables. Those are product data, not telemetry — ageing them out
 * would change what the product does, which is a decision for an operator and
 * not for a housekeeping job.
 *
 * Pure functions, no scheduling and no side-state: they are wired into the
 * existing daily branch of `RoomScheduler` so there is no second timer.
 */

import { sql } from "drizzle-orm";
import { db } from "../database/client.js";

export interface AnalyticsCleanupResult {
  aiLogsDeleted: number;
  pipelineTracesDeleted: number;
  toolAuditLogsDeleted: number;
  hookExecutionsDeleted: number;
  scheduledTaskRunsDeleted: number;
  eventBacklogDeleted: number;
  cutoff: Date;
}

/** Compute the cutoff date (now - retentionDays). */
export function computeCutoff(retentionDays: number, now: Date = new Date()): Date {
  const ms = retentionDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

/**
 * Delete rows older than `cutoff` and report how many, WITHOUT materialising
 * their ids.
 *
 * The previous shape was `.returning({ id })` and `rows.length`, which pulls
 * every deleted id into Node — on the first pass over a table that has never
 * been trimmed, that is the whole backlog in memory, in a job whose entire
 * purpose is a large delete. `db.execute` reports the row count from the driver
 * instead.
 */
async function deleteOlderThan(table: string, column: string, cutoff: Date): Promise<number> {
  // The cutoff goes in as an ISO STRING with an explicit cast, not as a Date.
  // Drizzle's typed builder knows a column is `timestamptz` and serializes for
  // you; raw SQL does not, and postgres.js rejects a Date parameter outright
  // ("The 'string' argument must be ... Received an instance of Date").
  const result = await db.execute(
    sql`delete from ${sql.identifier(table)} where ${sql.identifier(column)} < ${cutoff.toISOString()}::timestamptz`,
  );
  return (result as unknown as { count?: number }).count ?? 0;
}

export const deleteOldAiLogs = (cutoff: Date): Promise<number> =>
  deleteOlderThan("ai_logs", "created_at", cutoff);

export const deleteOldPipelineTraces = (cutoff: Date): Promise<number> =>
  deleteOlderThan("pipeline_traces", "created_at", cutoff);

/** Tool arguments and outputs. The largest per-row payload of the six. */
export const deleteOldToolAuditLogs = (cutoff: Date): Promise<number> =>
  deleteOlderThan("tool_audit_logs", "created_at", cutoff);

export const deleteOldHookExecutions = (cutoff: Date): Promise<number> =>
  deleteOlderThan("hook_executions", "created_at", cutoff);

/** `started_at`, not `created_at`: this table has no `created_at` column. */
export const deleteOldScheduledTaskRuns = (cutoff: Date): Promise<number> =>
  deleteOlderThan("scheduled_task_runs", "started_at", cutoff);

/**
 * Only COMPLETED backlog events age out.
 *
 * `pending` is work still queued, and `processing` may be a zombie from a prior
 * crash that `resetStuckProcessingEvents()` recovers at boot — deleting either
 * by age would silently drop events the system still owes an answer for.
 */
export async function deleteOldCompletedBacklog(cutoff: Date): Promise<number> {
  const result = await db.execute(
    sql`delete from event_backlog where status = 'completed' and created_at < ${cutoff.toISOString()}::timestamptz`,
  );
  return (result as unknown as { count?: number }).count ?? 0;
}

/** Run a full cleanup pass. Safe to call repeatedly (idempotent). */
export async function runAnalyticsCleanup(retentionDays: number): Promise<AnalyticsCleanupResult> {
  const cutoff = computeCutoff(retentionDays);
  const [
    aiLogsDeleted,
    pipelineTracesDeleted,
    toolAuditLogsDeleted,
    hookExecutionsDeleted,
    scheduledTaskRunsDeleted,
    eventBacklogDeleted,
  ] = await Promise.all([
    deleteOldAiLogs(cutoff),
    deleteOldPipelineTraces(cutoff),
    deleteOldToolAuditLogs(cutoff),
    deleteOldHookExecutions(cutoff),
    deleteOldScheduledTaskRuns(cutoff),
    deleteOldCompletedBacklog(cutoff),
  ]);
  return {
    aiLogsDeleted,
    pipelineTracesDeleted,
    toolAuditLogsDeleted,
    hookExecutionsDeleted,
    scheduledTaskRunsDeleted,
    eventBacklogDeleted,
    cutoff,
  };
}
