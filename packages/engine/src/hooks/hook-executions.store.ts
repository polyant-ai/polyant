// SPDX-License-Identifier: AGPL-3.0-or-later

import { asc, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { hookExecutions } from "./hooks.schema.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import type { HookActionType, HookEvent } from "./hook-types.js";

/** One hook execution outcome, as persisted for the conversation UI. */
export interface HookExecutionRow {
  id: string;
  instanceId: string;
  conversationId: string;
  hookId: string;
  event: HookEvent;
  actionType: HookActionType;
  toolName: string;
  success: boolean;
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

export interface RecordHookExecutionInput {
  instanceId: InstanceSlug;
  conversationId: string;
  hookId: string;
  event: HookEvent;
  actionType: HookActionType;
  toolName: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

function toRow(r: typeof hookExecutions.$inferSelect): HookExecutionRow {
  return {
    id: r.id,
    instanceId: r.instanceId,
    conversationId: r.conversationId,
    hookId: r.hookId,
    event: r.event as HookEvent,
    actionType: r.actionType as HookActionType,
    toolName: r.toolName,
    success: r.success,
    error: r.error,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  };
}

/** Insert one execution record. The runner calls this fire-and-forget. */
export async function recordHookExecution(input: RecordHookExecutionInput): Promise<void> {
  await db.insert(hookExecutions).values({
    instanceId: input.instanceId,
    conversationId: input.conversationId,
    hookId: input.hookId,
    event: input.event,
    actionType: input.actionType,
    toolName: input.toolName,
    success: input.success,
    error: input.error ?? null,
    durationMs: input.durationMs,
  });
}

/** Executions for one conversation, oldest first (timeline order). */
export async function listHookExecutions(
  conversationId: string,
  limit = 200,
): Promise<HookExecutionRow[]> {
  const rows = await db
    .select()
    .from(hookExecutions)
    .where(eq(hookExecutions.conversationId, conversationId))
    .orderBy(asc(hookExecutions.createdAt))
    .limit(limit);
  return rows.map(toRow);
}
