// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAuditLogger } from "../../audit/audit-logger.js";
import { buildConversationApi } from "../../conversations/conversation-history-api.js";
import { getHookRegistry } from "../hook-registry.js";
import { buildHookContext } from "../hook-context.js";
import type { HookActionExecutor, HookRunContext } from "../hook-types.js";

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

    const audit = createAuditLogger(functionName, ctx.instanceId, ctx.conversationId);
    const conversation = buildConversationApi(ctx.conversationId);
    const hookCtx = buildHookContext(hook.event, payload, ctx, conversation, audit);

    const result = await def.handler(hookCtx);
    if (!result) return;

    if (result.halt?.message?.trim()) capture({ halt: { message: result.halt.message } });
    if (result.replaceResponse?.message?.trim()) {
      // Runtime enforcement of replaceResponse ⇒ mutatesResponse (can't be static —
      // it's a handler return). Never a silent no-op: warn when the flag is missing.
      if (!def.mutatesResponse) {
        console.warn(
          `[hooks] "${functionName}" returned replaceResponse without declaring mutatesResponse:true — honored only on non-streamed turns.`,
        );
      }
      capture({ replaceResponse: { message: result.replaceResponse.message } });
    }
    if (typeof result.injectContext === "string" && result.injectContext.trim()) {
      capture({ injectContext: result.injectContext.slice(0, 4000) });
    }
  },
};
