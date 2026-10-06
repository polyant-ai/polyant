// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, desc, inArray, sql, count } from "drizzle-orm";
import { db } from "../database/client.js";
import {
  scheduledTaskRuns,
  scheduledTasks,
  type RunStatus,
  type TriggerType,
  type ToolCallEntry,
  type TokenUsageEntry,
  type ScheduledTaskRun,
} from "./schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";

export interface RunWithTaskName extends ScheduledTaskRun {
  taskName: string;
}

/** Build the common completion fields (status, completedAt, durationMs). */
function completionSet(status: RunStatus) {
  return {
    status,
    completedAt: new Date(),
    durationMs: sql`(EXTRACT(EPOCH FROM (NOW() - ${scheduledTaskRuns.startedAt})) * 1000)::integer`,
  };
}

/** Create a new run entry in "running" state. Returns the run ID. */
export async function createRun(
  taskId: string,
  instanceId: InstanceSlug,
  triggerType: TriggerType,
): Promise<string> {
  const rows = await db
    .insert(scheduledTaskRuns)
    .values({
      taskId,
      instanceId,
      status: "running",
      triggerType,
      startedAt: new Date(),
    })
    .returning({ id: scheduledTaskRuns.id });

  if (!rows[0]) throw new Error("Failed to create run log entry — insert returned no rows");
  return rows[0].id;
}

/** Mark a run as successfully completed */
export async function completeRun(
  runId: string,
  data: {
    output?: string;
    toolCalls?: ToolCallEntry[];
    tokenUsage?: TokenUsageEntry;
    conversationId?: string;
  },
): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({
      ...completionSet("success"),
      output: data.output ?? null,
      toolCalls: data.toolCalls ?? [],
      tokenUsage: data.tokenUsage ?? {},
      conversationId: data.conversationId ?? null,
    })
    .where(eq(scheduledTaskRuns.id, runId));
}

/** Mark a run as failed */
export async function failRun(runId: string, error: string): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({
      ...completionSet("error"),
      error,
    })
    .where(eq(scheduledTaskRuns.id, runId));
}

/**
 * The runs of these tasks that are still `running`, as observed now.
 *
 * A process killed mid-run leaves BOTH a `scheduled_tasks` row marked `running` and a
 * `scheduled_task_runs` row in the same state. Recovering only the task row would leave
 * the run log claiming, forever, that a run is in progress — and the run log is what an
 * operator reads to find out what happened.
 *
 * Read this while the task row is still marked `running`: no new run can be claimed
 * until the marker is cleared, so every run returned belongs to the claim being recovered.
 */
export async function findDanglingRuns(taskIds: string[]): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const rows = await db
    .select({ id: scheduledTaskRuns.id })
    .from(scheduledTaskRuns)
    .where(and(inArray(scheduledTaskRuns.taskId, taskIds), eq(scheduledTaskRuns.status, "running")));
  return rows.map((row) => row.id);
}

/**
 * Close the given runs, observed by `findDanglingRuns`, as an error.
 *
 * Only the observed runs: closing every `running` run of the task would also close a run
 * claimed after the recovery cleared the marker, one that is still live. Returns the
 * number of rows closed.
 */
export async function failDanglingRuns(runIds: string[], error: string): Promise<number> {
  if (runIds.length === 0) return 0;
  const rows = await db
    .update(scheduledTaskRuns)
    .set({ ...completionSet("error"), error })
    .where(and(inArray(scheduledTaskRuns.id, runIds), eq(scheduledTaskRuns.status, "running")))
    .returning({ id: scheduledTaskRuns.id });
  return rows.length;
}

/** List runs for an instance, with optional filters. Returns paginated results + total count. */
export async function listRuns(
  instanceId: InstanceSlug,
  opts: {
    taskId?: string;
    status?: RunStatus;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ runs: RunWithTaskName[]; total: number }> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions = [eq(scheduledTaskRuns.instanceId, instanceId)];
  if (opts.taskId) {
    conditions.push(eq(scheduledTaskRuns.taskId, opts.taskId));
  }
  if (opts.status) {
    conditions.push(eq(scheduledTaskRuns.status, opts.status));
  }

  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: scheduledTaskRuns.id,
        taskId: scheduledTaskRuns.taskId,
        instanceId: scheduledTaskRuns.instanceId,
        status: scheduledTaskRuns.status,
        triggerType: scheduledTaskRuns.triggerType,
        startedAt: scheduledTaskRuns.startedAt,
        completedAt: scheduledTaskRuns.completedAt,
        durationMs: scheduledTaskRuns.durationMs,
        output: scheduledTaskRuns.output,
        error: scheduledTaskRuns.error,
        toolCalls: scheduledTaskRuns.toolCalls,
        tokenUsage: scheduledTaskRuns.tokenUsage,
        conversationId: scheduledTaskRuns.conversationId,
        taskName: scheduledTasks.name,
      })
      .from(scheduledTaskRuns)
      .leftJoin(scheduledTasks, eq(scheduledTaskRuns.taskId, scheduledTasks.id))
      .where(where)
      .orderBy(desc(scheduledTaskRuns.startedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(scheduledTaskRuns)
      .where(where),
  ]);

  return {
    runs: rows.map((r) => ({
      ...r,
      taskName: r.taskName ?? "(deleted)",
    })) as RunWithTaskName[],
    total: countRows[0]?.total ?? 0,
  };
}
