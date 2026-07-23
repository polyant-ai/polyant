// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAuditLogger } from "../../audit/audit-logger.js";
import { buildConversationApi } from "../../conversations/conversation-history-api.js";
import { getHookRegistry } from "../hook-registry.js";
import { buildHookContext } from "../hook-context.js";
import { scopeSecrets } from "../../agents/tools/registry.js";
import type { HookActionExecutor, HookRunContext } from "../hook-types.js";

/**
 * Warn when a hook returns a mutation control (replaceResponse, regenerate)
 * without declaring mutatesResponse:true.
 */
function warnIfMutationUndeclared(
  mutatesResponse: boolean | undefined,
  functionName: string,
  action: "replaceResponse" | "regenerate",
): void {
  if (!mutatesResponse) {
    console.warn(
      `[hooks] "${functionName}" returned ${action} without declaring mutatesResponse:true — honored only on non-streamed turns.`,
    );
  }
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

    if (result.halt?.message?.trim()) capture({ halt: { message: result.halt.message } });
    if (result.replaceResponse?.message?.trim()) {
      // Runtime enforcement of replaceResponse ⇒ mutatesResponse (can't be static —
      // it's a handler return). Never a silent no-op: warn when the flag is missing.
      warnIfMutationUndeclared(def.mutatesResponse, functionName, "replaceResponse");
      capture({ replaceResponse: { message: result.replaceResponse.message } });
    }
    if (result.regenerate) {
      // Same runtime gate as replaceResponse: regenerate mutates the turn, so it
      // is honored only on non-streamed (declare-and-buffer) turns.
      warnIfMutationUndeclared(def.mutatesResponse, functionName, "regenerate");
      capture({ regenerate: { reason: result.regenerate.reason } });
    }
    if (typeof result.injectContext === "string" && result.injectContext.trim()) {
      capture({ injectContext: result.injectContext.slice(0, 4000) });
    }
  },
};
