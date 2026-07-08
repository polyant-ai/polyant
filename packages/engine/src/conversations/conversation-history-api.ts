// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConversationHistoryApi, ConversationMessage } from "@polyant-ai/plugin-sdk";

/** Wide window pulled from the store before role-filtering + the `n` cut. */
const HISTORY_WINDOW = 100;

/**
 * Build a read-only {@link ConversationHistoryApi} over `conversationStore`,
 * faithful to the SDK contract: filter by role FIRST, then take the last `n`
 * (oldest → newest); `n === 0` ⇒ all matching, `n < 0` ⇒ none.
 *
 * The accessor is **lazy** — the store (and its postgres pool) is `import()`ed
 * only when `getRecentMessages` is actually called, so wiring it into every
 * tool/hook context costs nothing (no DB query, no eager module init) until a
 * consumer reads history. Shared by the tool context (`supervisor`) and the hook
 * `function` action executor so both expose the same accessor.
 */
export function buildConversationApi(conversationId: string): ConversationHistoryApi {
  return {
    async getRecentMessages(n, opts) {
      const { conversationStore } = await import("./store.js");
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
