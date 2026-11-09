// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, count, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { aiLogs } from "../ai-gateway/logger.js";
import { hookExecutions } from "../hooks/hooks.schema.js";
import { modelExchanges } from "./exchanges.schema.js";

/** One model call of a turn, as `ai_logs` recorded it. */
export interface PathModelCall {
  id: string;
  /** "conversation" for the agent's own loop, "service" for any other call, "embedding" for an embedder. */
  callType: string;
  /** What a service call was for (title, memory, hook, tool…); null on the agent's calls. */
  purpose: string | null;
  /** The hook function or tool that made the call; null otherwise. */
  originName: string | null;
  /** The hook run id or tool call id the call nests under; null otherwise. */
  parentRef: string | null;
  provider: string;
  model: string;
  startedAt: string | null;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  stepCount: number;
  outcome: string;
  errorKind: string | null;
  /** How many raw exchanges were kept for the call (debug on); 0 when none. */
  exchangeCount: number;
}

/** One hook run of a turn. */
export interface PathHookRun {
  id: string;
  name: string;
  event: string;
  startedAt: string | null;
  durationMs: number;
  success: boolean;
  error: string | null;
  args: Record<string, unknown> | null;
  result: string | null;
}

export interface PathExchange {
  stepIndex: number;
  attempt: number;
  status: number | null;
  request: unknown;
  response: unknown;
  createdAt: string;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** The model calls and hook runs filed under a turn's message, in start order. */
export async function readTurnRuns(
  conversationId: string,
  messageId: string,
): Promise<{ modelCalls: PathModelCall[]; hookRuns: PathHookRun[] }> {
  const [calls, hooks, kept] = await Promise.all([
    db
      .select({
        id: aiLogs.id,
        callType: aiLogs.callType,
        purpose: aiLogs.purpose,
        originName: aiLogs.originName,
        parentRef: aiLogs.parentRef,
        provider: aiLogs.provider,
        model: aiLogs.model,
        startedAt: aiLogs.startedAt,
        durationMs: aiLogs.durationMs,
        promptTokens: aiLogs.promptTokens,
        completionTokens: aiLogs.completionTokens,
        cachedInputTokens: aiLogs.cachedInputTokens,
        cacheCreationInputTokens: aiLogs.cacheCreationInputTokens,
        costUsd: aiLogs.estimatedCostUsd,
        stepCount: aiLogs.stepCount,
        outcome: aiLogs.outcome,
        errorKind: aiLogs.errorKind,
      })
      .from(aiLogs)
      .where(and(eq(aiLogs.messageId, messageId), eq(aiLogs.conversationId, conversationId)))
      .orderBy(asc(aiLogs.startedAt)),
    db
      .select({
        id: hookExecutions.id,
        name: hookExecutions.toolName,
        event: hookExecutions.event,
        startedAt: hookExecutions.startedAt,
        durationMs: hookExecutions.durationMs,
        success: hookExecutions.success,
        error: hookExecutions.error,
        args: hookExecutions.args,
        result: hookExecutions.result,
      })
      .from(hookExecutions)
      .where(and(eq(hookExecutions.messageId, messageId), eq(hookExecutions.conversationId, conversationId)))
      .orderBy(asc(hookExecutions.startedAt)),
    db
      .select({ aiLogId: modelExchanges.aiLogId, n: count() })
      .from(modelExchanges)
      .where(and(eq(modelExchanges.messageId, messageId), eq(modelExchanges.conversationId, conversationId)))
      .groupBy(modelExchanges.aiLogId),
  ]);
  const keptBy = new Map(kept.map((k) => [k.aiLogId, Number(k.n)]));
  return {
    modelCalls: calls.map((c) => ({ ...c, startedAt: iso(c.startedAt), exchangeCount: keptBy.get(c.id) ?? 0 })),
    hookRuns: hooks.map((h) => ({ ...h, startedAt: iso(h.startedAt) })),
  };
}

/**
 * The raw exchanges of one model call of a turn, in step and attempt order.
 * Empty when the call is not filed under that message and conversation, so an
 * id from another conversation reads nothing.
 */
export async function readExchanges(conversationId: string, messageId: string, aiLogId: string): Promise<PathExchange[]> {
  const rows = await db
    .select({
      stepIndex: modelExchanges.stepIndex,
      attempt: modelExchanges.attempt,
      status: modelExchanges.status,
      request: modelExchanges.request,
      response: modelExchanges.response,
      createdAt: modelExchanges.createdAt,
    })
    .from(modelExchanges)
    .where(
      and(
        eq(modelExchanges.aiLogId, aiLogId),
        eq(modelExchanges.messageId, messageId),
        eq(modelExchanges.conversationId, conversationId),
      ),
    )
    .orderBy(asc(modelExchanges.stepIndex), asc(modelExchanges.attempt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
