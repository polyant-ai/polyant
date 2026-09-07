// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAuditLogger } from "../../audit/audit-logger.js";
import { buildConversationApi } from "../../conversations/conversation-history-api.js";
import { getHookRegistry } from "../hook-registry.js";
import { buildHookContext } from "../hook-context.js";
import { scopeSecrets } from "../../agents/tools/registry.js";
import type { HookActionExecutor, HookRunContext } from "../hook-types.js";

/**
 * Warn when a hook returns `replaceResponse` without declaring mutatesResponse:true.
 * replaceResponse is a cheap text swap, so it is still honored on non-streamed turns
 * (warn-only). `regenerate` diverges — see its call site — because it replays the
 * whole turn and is therefore HARD-gated on the flag.
 */
function warnReplaceUndeclared(mutatesResponse: boolean | undefined, functionName: string): void {
  if (!mutatesResponse) {
    console.warn(
      `[hooks] "${functionName}" returned replaceResponse without declaring mutatesResponse:true — honored only on non-streamed turns.`,
    );
  }
}

/**
 * Upper bound on a hook-authored reply (halt / replaceResponse). These become a
 * persisted assistant message AND an outbound channel send, so an unbounded one
 * — a handler bug that concatenates the whole history is enough — writes an
 * arbitrarily large row and then fails opaquely against the channel's own payload
 * limit. Generous compared with `injectContext`'s 4000: this is a user-visible
 * reply, not prompt scaffolding.
 */
const MAX_HOOK_MESSAGE_CHARS = 16_000;

function capMessage(message: string): string {
  if (message.length <= MAX_HOOK_MESSAGE_CHARS) return message;
  console.warn(`[hooks] hook-authored message truncated to ${MAX_HOOK_MESSAGE_CHARS} chars (was ${message.length}).`);
  return message.slice(0, MAX_HOOK_MESSAGE_CHARS);
}

/**
 * `function` action: run a registered hook function and map its control return
 * onto the runner's `capture`. Throws on misconfiguration (missing/unknown
 * function) — the runner catches, audits, and continues.
 */
export const functionActionExecutor: HookActionExecutor = {
  async execute(hook, payload, ctx: HookRunContext, capture) {
    const { functionName } = hook.actionConfig;
    if (!functionName) throw new Error("function action is missing functionName");
    const def = getHookRegistry().get(functionName);
    if (!def) throw new Error(`hook function "${functionName}" is not registered`);

    // Gate on missing required secrets (mirrors the supervisor skipping tools with
    // unconfigured secrets). Optional specs are ignored — the handler decides.
    // Throwing here means the runner audits the misconfiguration instead of running
    // the hook with `undefined` secrets and failing opaquely downstream.
    const missing = def.requiredSecrets
      .filter((s) => !s.optional)
      .map((s) => s.key)
      .filter((k) => !ctx.secrets[k]);
    if (missing.length > 0) {
      throw new Error(
        `hook function "${functionName}" is missing required secret(s): ${missing.join(", ")}`,
      );
    }

    // Least-privilege: the hook only sees the secrets it declared (mirrors the
    // supervisor's per-tool `scopeSecrets`). Undeclared keys are absent — a hook,
    // like a tool, can be third-party plugin code.
    const declared = new Set(def.requiredSecrets.map((s) => s.key));
    const scopedCtx: HookRunContext = { ...ctx, secrets: scopeSecrets(ctx.secrets, declared) ?? {} };

    const audit = createAuditLogger(functionName, ctx.instanceId, ctx.conversationId);
    const conversation = buildConversationApi(ctx.conversationId);
    const hookCtx = buildHookContext(hook.event, payload, scopedCtx, conversation, audit);

    const result = await def.handler(hookCtx);
    if (!result) return;
    // A handler that returned only after its deadline (or after the pipeline was
    // cancelled) has no say over a turn the runner already moved past. Dropping
    // the control return here keeps a late halt/replace from reaching a reply
    // that has, by then, been delivered.
    if (scopedCtx.abortSignal?.aborted) {
      console.warn(`[hooks] "${functionName}" returned after it was abandoned — control return ignored.`);
      return;
    }

    if (result.halt?.message?.trim()) {
      // `persist` rides along untouched: the pipeline resolves the default (true).
      capture({ halt: { message: capMessage(result.halt.message), persist: result.halt.persist } });
    }
    if (result.replaceResponse?.message?.trim()) {
      // Runtime enforcement of replaceResponse ⇒ mutatesResponse (can't be static —
      // it's a handler return). Never a silent no-op: warn when the flag is missing.
      warnReplaceUndeclared(def.mutatesResponse, functionName);
      capture({ replaceResponse: { message: capMessage(result.replaceResponse.message) } });
    }
    if (result.regenerate) {
      // regenerate replays the ENTIRE turn (system prompt + tools) up to MAX_REGENERATIONS×
      // — far costlier than replaceResponse's text swap. So unlike replaceResponse it is
      // HARD-gated on mutatesResponse: honored only when declared, else warn + DROP, so a
      // hook missing the flag can never trigger a surprise multi-pass cost on a non-streamed
      // turn. (On streamed turns it never reaches the buffered replay loop anyway.)
      if (def.mutatesResponse) {
        capture({ regenerate: { reason: result.regenerate.reason } });
      } else {
        console.warn(
          `[hooks] "${functionName}" returned regenerate without declaring mutatesResponse:true — ignored.`,
        );
      }
    }
    if (typeof result.injectContext === "string" && result.injectContext.trim()) {
      capture({ injectContext: result.injectContext.slice(0, 4000) });
    }
  },
};
