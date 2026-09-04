// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConversationStateApi } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../utils/error.js";
import { createAuditLogger } from "../audit/audit-logger.js";
import { getEnabledHooks } from "./hooks.store.js";
import { recordHookExecution } from "./hook-executions.store.js";
import { functionActionExecutor } from "./actions/function-action.js";
import type {
  HookActionExecutor,
  HookActionType,
  HookEvent,
  HookEventPayload,
  HookExecutionCapture,
  HookExecutionSummary,
  HookHaltSignal,
  HookRegenerateSignal,
  HookReplaceSignal,
  HookRunContext,
  InstanceHookRow,
} from "./hook-types.js";

/** Action-type → executor. Future action types register here. */
const executors = new Map<HookActionType, HookActionExecutor>([
  ["function", functionActionExecutor],
]);

/** First halt requested across a run's summaries, or undefined. */
export function firstHalt(summaries: HookExecutionSummary[]): HookHaltSignal | undefined {
  return summaries.find((s) => s.halt)?.halt;
}

/** First response replacement requested across a run's summaries, or undefined. */
export function firstReplaceResponse(summaries: HookExecutionSummary[]): HookReplaceSignal | undefined {
  return summaries.find((s) => s.replaceResponse)?.replaceResponse;
}

/** First regenerate requested across a run's summaries, or undefined. */
export function firstRegenerate(summaries: HookExecutionSummary[]): HookRegenerateSignal | undefined {
  return summaries.find((s) => s.regenerate)?.regenerate;
}

/**
 * Set on a persisted reply when a hook (not the LLM) authored it, so the UI can
 * badge it. Typed with an index signature so it slots straight into the message
 * `metadata` jsonb column (Record<string, unknown>).
 */
export type HookProvenance = {
  source: "hook";
  hookName: string;
} & Record<string, unknown>;

/**
 * Provenance for a reply authored by a hook: the halt (pre-LLM) or the
 * replaceResponse (post-LLM) hook that produced it, badged by function name.
 * Replace wins over halt (they never co-occur in one phase). Undefined when the
 * LLM authored the reply.
 */
export function hookProvenance(summaries: HookExecutionSummary[]): HookProvenance | undefined {
  const src = summaries.find((s) => s.replaceResponse) ?? summaries.find((s) => s.halt);
  return src ? { source: "hook", hookName: src.toolName || "hook" } : undefined;
}

/** All context-injection strings requested across a run's summaries, in order. */
export function collectInjectContext(summaries: HookExecutionSummary[]): string[] {
  return summaries.map((s) => s.injectContext).filter((c): c is string => !!c);
}

/**
 * Reject after `ms`, and tell the hook it is over by aborting `onExpiry`.
 *
 * The rejection alone only unblocks the RUNNER — the handler's promise keeps
 * running. A hook that outlives its timeout and then writes (state, an outbound
 * call) lands its effect after the turn has already moved on, which breaks the
 * "timed-out hook leaves no trace" contract the state buffer relies on. The
 * signal is the cooperative half of the fix; {@link fenceState} is the half that
 * does not need the hook's cooperation.
 */
function withTimeout(promise: Promise<void>, ms: number, label: string, onExpiry: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onExpiry.abort();
      reject(new Error(`hook ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * A conversation-state view whose WRITES stop working once `signal` aborts.
 * Reads stay live (harmless, and a late read that informs a log line is fine).
 *
 * Without this, a hook that ignores its abort signal — third-party plugin code,
 * or anything blocked in a fetch with no signal wired — can still mutate the
 * shared per-run buffer after the runner gave up on it, so a discarded hook's
 * writes ride the commit-on-success flush of a turn it was never part of.
 */
function fenceState(state: ConversationStateApi, signal: AbortSignal, label: string): ConversationStateApi {
  const refuse = (op: string): boolean => {
    if (!signal.aborted) return false;
    console.warn(`[hooks] ${label}: ignoring state.${op} — the hook was already abandoned (timeout or pipeline abort).`);
    return true;
  };
  return {
    ...state,
    get: (key) => state.get(key),
    getAll: () => state.getAll(),
    set: (key, value) => { if (!refuse("set")) state.set(key, value); },
    delete: (key) => { if (!refuse("delete")) state.delete(key); },
  };
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
    // The summary/telemetry field stays NAMED `toolName` (renaming would ripple
    // to the web + SSE, out of scope) but post-cutover it holds the function name.
    const toolName = hook.actionConfig.functionName ?? "";
    const audit = createAuditLogger(`hook:${toolName}`, ctx.instanceId, ctx.conversationId);
    const started = Date.now();
    let success = true;
    let error: string | undefined;
    // Input/output reported incrementally by the executor — args land before
    // the tool runs, so they survive failures and timeouts.
    const captured: HookExecutionCapture = {};
    const capture = (data: HookExecutionCapture) => Object.assign(captured, data);
    // Per-hook deadline, folded together with the pipeline's own signal so a
    // hook sees ONE signal that means "stop, nobody is reading your result".
    const expiry = new AbortController();
    const label = `${event}/${toolName}`;
    const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, expiry.signal]) : expiry.signal;
    const hookCtx: HookRunContext = {
      ...ctx,
      abortSignal: signal,
      state: ctx.state ? fenceState(ctx.state, signal, label) : ctx.state,
    };
    try {
      await withTimeout(executor.execute(hook, payload, hookCtx, capture), hook.timeoutMs, label, expiry);
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
      halt: captured.halt,
      replaceResponse: captured.replaceResponse,
      regenerate: captured.regenerate,
      injectContext: captured.injectContext,
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
    // First halt wins: stop remaining hooks for this event. Telemetry/audit for
    // the halting hook is already recorded above. Post-LLM callers ignore the
    // halt (runPipelinePost never reads it) — the break only keeps behaviour
    // predictable across events.
    if (captured.halt) break;
  }
  return summaries;
}
