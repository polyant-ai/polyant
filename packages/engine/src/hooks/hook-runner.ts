// SPDX-License-Identifier: AGPL-3.0-or-later

import { errMsg } from "../utils/error.js";
import { createAuditLogger } from "../audit/audit-logger.js";
import { getEnabledHooks } from "./hooks.store.js";
import { toolActionExecutor } from "./actions/tool-action.js";
import type {
  HookActionExecutor,
  HookActionType,
  HookEvent,
  HookEventPayload,
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
 * never the rendered args (PII).
 */
export async function runHooks(
  event: HookEvent,
  payload: HookEventPayload,
  ctx: HookRunContext,
): Promise<void> {
  let hooks: InstanceHookRow[];
  try {
    hooks = await getEnabledHooks(ctx.instanceId, event);
  } catch (err) {
    console.error(`[hooks] failed to load hooks for ${ctx.instanceId}/${event}:`, errMsg(err));
    return;
  }
  if (hooks.length === 0) return;

  for (const hook of hooks) {
    if (ctx.abortSignal?.aborted) return;
    const executor = executors.get(hook.actionType);
    if (!executor) {
      console.warn(`[hooks] ${event} hook ${hook.id}: unknown action type "${hook.actionType}" — skipping`);
      continue;
    }
    const toolName = hook.actionConfig.toolName;
    const audit = createAuditLogger(`hook:${toolName}`, ctx.instanceId, ctx.conversationId);
    const started = Date.now();
    try {
      await withTimeout(executor.execute(hook, payload, ctx), hook.timeoutMs, `${event}/${toolName}`);
      audit.log({
        action: `hook:${event}`,
        success: true,
        durationMs: Date.now() - started,
        details: { actionType: hook.actionType },
      });
    } catch (err) {
      console.error(`[hooks] ${event} hook ${hook.id} (${toolName}) failed:`, errMsg(err));
      audit.log({
        action: `hook:${event}`,
        success: false,
        error: errMsg(err),
        durationMs: Date.now() - started,
        details: { actionType: hook.actionType },
      });
    }
  }
}
