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
 * not for a housekeeping job. The one exception is the request a debug-mode
 * turn stores beside its message (`debug_payload`), cleared after its own short
 * window (`config.retention.debugPayloadDays`): it is diagnostic, and it copies
 * the whole prompt and conversation at every turn.
 *
 * Pure functions, no scheduling and no side-state: they are wired into the
 * existing daily branch of `RoomScheduler` so there is no second timer.
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "../database/client.js";
import { config } from "../config.js";

export interface AnalyticsCleanupResult {
  aiLogsDeleted: number;
  pipelineTracesDeleted: number;
  toolAuditLogsDeleted: number;
  hookExecutionsDeleted: number;
  scheduledTaskRunsDeleted: number;
  eventBacklogDeleted: number;
  debugPayloadsCleared: number;
  cutoff: Date;
}

/** Compute the cutoff date (now - retentionDays). */
export function computeCutoff(retentionDays: number, now: Date = new Date()): Date {
  const ms = retentionDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

/** Rows deleted per statement: each statement stays far under the main pool's per-statement cap. */
const DELETE_BATCH = 5000;

/**
 * Delete the rows `where` selects, a batch per statement, and report how many,
 * WITHOUT materialising their ids.
 *
 * One statement over the whole backlog meets the per-statement cap of the main
 * pool on a large installation (a shortened retention, a table never trimmed),
 * and rolls back everything it did: the next try, a day later, has more to do.
 * Batches commit as they go, so a run that stops still leaves less behind.
 */
async function deleteInBatches(table: string, where: SQL): Promise<number> {
  const target = sql.identifier(table);
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      delete from ${target} where ctid = any(array(
        select ctid from ${target} where ${where} limit ${DELETE_BATCH}
      ))`);
    const count = (result as unknown as { count?: number }).count ?? 0;
    deleted += count;
    if (count < DELETE_BATCH) return deleted;
  }
}

async function deleteOlderThan(table: string, column: string, cutoff: Date): Promise<number> {
  // The cutoff goes in as an ISO STRING with an explicit cast, not as a Date.
  // Drizzle's typed builder knows a column is `timestamptz` and serializes for
  // you; raw SQL does not, and postgres.js rejects a Date parameter outright
  // ("The 'string' argument must be ... Received an instance of Date").
  return deleteInBatches(table, sql`${sql.identifier(column)} < ${cutoff.toISOString()}::timestamptz`);
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
 * crash that the Room tick requeues once its lease expires — deleting either
 * by age would silently drop events the system still owes an answer for.
 */
export function deleteOldCompletedBacklog(cutoff: Date): Promise<number> {
  return deleteInBatches("event_backlog", sql`status = 'completed' and created_at < ${cutoff.toISOString()}::timestamptz`);
}

/** Debug payloads cleared per statement: each one is the whole request of a turn. */
const DEBUG_PAYLOAD_BATCH = 1000;

/** Clear the debug payload of messages older than `cutoff`, a batch per statement; the messages stay. */
export async function clearOldDebugPayloads(cutoff: Date): Promise<number> {
  let cleared = 0;
  for (;;) {
    const result = await db.execute(sql`
      update conversation_messages set debug_payload = null
      where id in (
        select id from conversation_messages
        where debug_payload is not null and created_at < ${cutoff.toISOString()}::timestamptz
        limit ${DEBUG_PAYLOAD_BATCH}
      )`);
    const count = (result as unknown as { count?: number }).count ?? 0;
    cleared += count;
    if (count < DEBUG_PAYLOAD_BATCH) return cleared;
  }
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
    debugPayloadsCleared,
  ] = await Promise.all([
    deleteOldAiLogs(cutoff),
    deleteOldPipelineTraces(cutoff),
    deleteOldToolAuditLogs(cutoff),
    deleteOldHookExecutions(cutoff),
    deleteOldScheduledTaskRuns(cutoff),
    deleteOldCompletedBacklog(cutoff),
    clearOldDebugPayloads(computeCutoff(config.retention.debugPayloadDays)),
  ]);
  return {
    aiLogsDeleted,
    pipelineTracesDeleted,
    toolAuditLogsDeleted,
    hookExecutionsDeleted,
    scheduledTaskRunsDeleted,
    eventBacklogDeleted,
    debugPayloadsCleared,
    cutoff,
  };
}
