// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, sql, type SQL } from "drizzle-orm";
import { db } from "../database/client.js";
import { conversationState } from "./schema.js";

/** Only scope in use today. `scope`/`scopeKey` are kept as an abstraction so a
 *  future "principal" tier can be added without a schema change. */
const CONVERSATION_SCOPE = "conversation";

/**
 * Load the shared state blob for a conversation. Returns `{}` when no row exists
 * yet (first turn). Read happens once per pipeline run (see `state.buffer.ts`).
 */
export async function loadConversationState(
  conversationId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ data: conversationState.data })
    .from(conversationState)
    .where(
      and(
        eq(conversationState.scope, CONVERSATION_SCOPE),
        eq(conversationState.scopeKey, conversationId),
      ),
    )
    .limit(1);
  return rows[0]?.data ?? {};
}

/**
 * Upsert the conversation state with a per-key shallow merge.
 *
 * Concurrent pipeline runs on the same conversation (rare: only non-coordinated
 * channels like web/openai) must not clobber each other's keys, so we merge the
 * dirty `set` keys into the existing JSONB (`||`) instead of overwriting the
 * whole blob, then drop the `remove` keys (`jsonb - text`, chained per key).
 *
 * No-op when there is nothing to persist.
 */
export async function flushConversationState(
  conversationId: string,
  agentId: string | null,
  set: Record<string, unknown>,
  remove: string[],
): Promise<void> {
  if (Object.keys(set).length === 0 && remove.length === 0) return;

  // Shallow-merge the dirty keys, then remove deleted keys one by one. Chained
  // `- text` (per key) avoids binding a JS array to `text[]`, which drizzle +
  // postgres-js do not parameterize reliably.
  const setJson = JSON.stringify(set);
  let dataExpr: SQL = sql`(${conversationState.data} || ${setJson}::jsonb)`;
  for (const key of remove) {
    dataExpr = sql`(${dataExpr} - ${key})`;
  }

  await db
    .insert(conversationState)
    .values({
      scope: CONVERSATION_SCOPE,
      scopeKey: conversationId,
      agentId: agentId ?? null,
      // On a fresh row there is nothing to merge/remove from, so the new row's
      // data is exactly the dirty `set` (deleted keys simply never existed).
      data: set,
    })
    .onConflictDoUpdate({
      target: [conversationState.scope, conversationState.scopeKey],
      set: { data: dataExpr, updatedAt: new Date() },
    });
}
