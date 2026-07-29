// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineHook } from "@polyant-ai/plugin-sdk";
// First-party hook: importing the engine's own store is fine in-tree, but it makes
// this function non-portable as an external plugin. If reset is ever needed from a
// plugin, expose it as a method on `ctx.conversation` in the SDK instead.
import { conversationStore } from "../../conversations/index.js";

/** Whole-message keyword, matched case-insensitively. Deliberately not configurable. */
const KEYWORD = "RESET";

/** Random 5-digit archive suffix (10000–99999 — always 5 chars). */
function randomSuffix(): string {
  return String(10000 + Math.floor(Math.random() * 90000));
}

/**
 * Pick an unused archive id: two random candidates, then a timestamp fallback, so a
 * collision can never make the rename fail.
 */
async function pickArchiveId(conversationId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = `${conversationId}#${randomSuffix()}`;
    if (!(await conversationStore.getConversation(candidate))) return candidate;
  }
  return `${conversationId}#${Date.now()}`;
}

/**
 * Archive the current conversation on a `RESET` message, so a tester can start from a
 * clean slate without leaving the chat. A conversation id is derived from the channel
 * id (the phone number on WhatsApp), so colleagues sharing one number otherwise share
 * a single ever-growing conversation across test runs.
 *
 * The old conversation is renamed, never deleted: its history stays browsable in the
 * admin panel under the suffixed id (`conversation_state` moves with it), and the next
 * inbound message re-creates the canonical id empty. The halt carries `persist: false`
 * so the RESET exchange itself lands in neither conversation.
 */
export default defineHook({
  name: "conversation-reset",
  description:
    'On a message that is exactly "RESET", archive the current conversation (rename it with a random 5-digit suffix) so the next message starts a fresh one. Intended for test instances.',
  handler: async (ctx) => {
    if (ctx.payload.message.text.trim().toUpperCase() !== KEYWORD) return;

    const conversationId = ctx.payload.conversation.id;
    try {
      const archiveId = await pickArchiveId(conversationId);
      await conversationStore.renameConversation(conversationId, archiveId);
      return {
        halt: { message: `RESET → ${archiveId.slice(conversationId.length)}`, persist: false },
      };
    } catch (err) {
      console.error(`[conversation-reset] rename failed for ${conversationId}:`, err);
      return {
        halt: { message: "RESET failed — the conversation was not archived.", persist: false },
      };
    }
  },
});
