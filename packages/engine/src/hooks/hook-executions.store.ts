// SPDX-License-Identifier: AGPL-3.0-or-later

import { asc, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { hookExecutions } from "./hooks.schema.js";
import type { AgentSlug } from "../instances/identifiers.js";
import type { HookActionType, HookEvent } from "./hook-types.js";

/** One hook execution outcome, as persisted for the conversation UI. */
export interface HookExecutionRow {
  id: string;
  agentId: string;
  conversationId: string;
  hookId: string;
  event: HookEvent;
  actionType: HookActionType;
  toolName: string;
  success: boolean;
  error: string | null;
  durationMs: number;
  /** Rendered tool args (post-template). Same exposure class as message `steps`. */
  args: Record<string, unknown> | null;
  /** Tool result, JSON-stringified and truncated. */
  result: string | null;
  createdAt: Date;
}

export interface RecordHookExecutionInput {
  agentId: AgentSlug;
  conversationId: string;
  hookId: string;
  event: HookEvent;
  actionType: HookActionType;
  toolName: string;
  success: boolean;
  error?: string;
  durationMs: number;
  args?: Record<string, unknown>;
  result?: string;
}

function toRow(r: typeof hookExecutions.$inferSelect): HookExecutionRow {
  return {
    id: r.id,
    agentId: r.agentId,
    conversationId: r.conversationId,
    hookId: r.hookId,
    event: r.event as HookEvent,
    actionType: r.actionType as HookActionType,
    toolName: r.toolName,
    success: r.success,
    error: r.error,
    durationMs: r.durationMs,
    args: r.args,
    result: r.result,
    createdAt: r.createdAt,
  };
}

/** Insert one execution record. The runner calls this fire-and-forget. */
export async function recordHookExecution(input: RecordHookExecutionInput): Promise<void> {
  await db.insert(hookExecutions).values({
    agentId: input.agentId,
    conversationId: input.conversationId,
    hookId: input.hookId,
    event: input.event,
    actionType: input.actionType,
    toolName: input.toolName,
    success: input.success,
    error: input.error ?? null,
    durationMs: input.durationMs,
    args: input.args ?? null,
    result: input.result ?? null,
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
