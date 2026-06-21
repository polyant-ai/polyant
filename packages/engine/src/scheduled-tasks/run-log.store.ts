// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, desc, sql, count } from "drizzle-orm";
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
import { type AgentSlug } from "../instances/identifiers.js";

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
  agentId: AgentSlug,
  triggerType: TriggerType,
): Promise<string> {
  const rows = await db
    .insert(scheduledTaskRuns)
    .values({
      taskId,
      agentId,
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

/** List runs for an instance, with optional filters. Returns paginated results + total count. */
export async function listRuns(
  agentId: AgentSlug,
  opts: {
    taskId?: string;
    status?: RunStatus;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ runs: RunWithTaskName[]; total: number }> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions = [eq(scheduledTaskRuns.agentId, agentId)];
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
        agentId: scheduledTaskRuns.agentId,
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
