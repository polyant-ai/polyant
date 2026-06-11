// SPDX-License-Identifier: AGPL-3.0-or-later

import { errMsg } from "../utils/error.js";
import { createAuditLogger } from "../audit/audit-logger.js";
import { getEnabledHooks } from "./hooks.store.js";
import { recordHookExecution } from "./hook-executions.store.js";
import { toolActionExecutor } from "./actions/tool-action.js";
import type {
  HookActionExecutor,
  HookActionType,
  HookEvent,
  HookEventPayload,
  HookExecutionCapture,
  HookExecutionSummary,
  HookRunContext,
  InstanceHookRow,
} from "./hook-types.js";

/** Action-type → executor. Future action types register here. */
const executors = new Map<HookActionType, HookActionExecutor>([
  ["tool", toolActionExecutor],
]);

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`hook ${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Run all enabled hooks for (instance, event), sequentially in position order.
 * Observe-only contract: every failure (load, executor, timeout) is logged and
 * swallowed — hooks never block the pipeline. Audit records the outcome but
 * never the rendered args (PII). Returns one summary per executed hook so
 * first-party consumers (typed SSE stream) can surface the outcomes live.
 */
export async function runHooks(
  event: HookEvent,
  payload: HookEventPayload,
  ctx: HookRunContext,
): Promise<HookExecutionSummary[]> {
  const summaries: HookExecutionSummary[] = [];
  let hooks: InstanceHookRow[];
  try {
    hooks = await getEnabledHooks(ctx.instanceId, event);
  } catch (err) {
    console.error(`[hooks] failed to load hooks for ${ctx.instanceId}/${event}:`, errMsg(err));
    return summaries;
  }
  if (hooks.length === 0) return summaries;

  for (const hook of hooks) {
    if (ctx.abortSignal?.aborted) return summaries;
    const executor = executors.get(hook.actionType);
    if (!executor) {
      console.warn(`[hooks] ${event} hook ${hook.id}: unknown action type "${hook.actionType}" — skipping`);
      continue;
    }
    const toolName = hook.actionConfig.toolName;
    const audit = createAuditLogger(`hook:${toolName}`, ctx.instanceId, ctx.conversationId);
    const started = Date.now();
    let success = true;
    let error: string | undefined;
    // Input/output reported incrementally by the executor — args land before
    // the tool runs, so they survive failures and timeouts.
    const captured: HookExecutionCapture = {};
    const capture = (data: HookExecutionCapture) => Object.assign(captured, data);
    try {
      await withTimeout(executor.execute(hook, payload, ctx, capture), hook.timeoutMs, `${event}/${toolName}`);
    } catch (err) {
      success = false;
      error = errMsg(err);
      console.error(`[hooks] ${event} hook ${hook.id} (${toolName}) failed:`, error);
    }
    const durationMs = Date.now() - started;
    summaries.push({
      hookId: hook.id,
      event,
      actionType: hook.actionType,
      toolName,
      success,
      error,
      durationMs,
      args: captured.args,
      result: captured.result,
    });
    audit.log({
      action: `hook:${event}`,
      success,
      error,
      durationMs,
      details: { actionType: hook.actionType },
    });
    // Per-conversation telemetry for the conversation detail UI — fire-and-forget,
    // a failed insert never affects the run.
    recordHookExecution({
      instanceId: ctx.instanceId,
      conversationId: ctx.conversationId,
      hookId: hook.id,
      event,
      actionType: hook.actionType,
      toolName,
      success,
      error,
      durationMs,
      args: captured.args,
      result: captured.result,
    }).catch((err) =>
      console.error(`[hooks] failed to record execution for hook ${hook.id}:`, errMsg(err)),
    );
  }
  return summaries;
}
