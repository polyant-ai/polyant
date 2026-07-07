// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConversationHistoryApi, ConversationMessage } from "@polyant-ai/plugin-sdk";
import { createAuditLogger } from "../../audit/audit-logger.js";
import { conversationStore } from "../../conversations/store.js";
import { getHookRegistry } from "../hook-registry.js";
import { buildHookContext } from "../hook-context.js";
import type { HookActionExecutor, HookRunContext } from "../hook-types.js";

/** Wide window pulled from the store before role-filtering + the `n` cut. */
const HISTORY_WINDOW = 100;

/**
 * Minimal `ConversationHistoryApi` over `conversationStore`. The engine doesn't
 * hand tools a `conversation` accessor today (ToolContext.conversation is
 * unset), so hooks get one built here, faithful to the SDK contract: filter by
 * role FIRST, then take the last `n`; `n === 0` ⇒ all, `n < 0` ⇒ none.
 */
function buildConversationApi(conversationId: string): ConversationHistoryApi {
  return {
    async getRecentMessages(n, opts) {
      const rows = await conversationStore.getRecentMessages(conversationId, HISTORY_WINDOW);
      const roleSet = opts?.roles && opts.roles.length > 0 ? new Set(opts.roles) : undefined;
      // ModelMessage content is string | multimodal parts; the SDK contract is
      // text-only, so keep string-content rows and coerce role to the SDK union.
      const filtered: ConversationMessage[] = rows
        .filter((r) => typeof r.content === "string")
        .map((r) => ({ role: r.role as ConversationMessage["role"], content: r.content as string }))
        .filter((r) => !roleSet || roleSet.has(r.role));
      if (n < 0) return [];
      if (n === 0) return filtered;
      return filtered.slice(-n);
    },
  };
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
