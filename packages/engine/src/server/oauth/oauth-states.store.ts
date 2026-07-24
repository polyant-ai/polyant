// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, lt } from "drizzle-orm";
import { db } from "../../database/client.js";
import { oauthStates } from "./oauth-states.schema.js";
import { encrypt, decrypt } from "../../crypto/index.js";

// Authorize links are short-lived; the user clicks within minutes.
const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateRow {
  conversationId: string;
  instanceId: string;
  provider: string;
  codeVerifier: string | null;
}

/** Persist a pending authorization. Returns nothing; the caller already holds
 *  the `state` nonce it generated. */
export async function createOAuthState(input: {
  state: string;
  conversationId: string;
  instanceId: string;
  provider: string;
  codeVerifier: string | null;
}): Promise<void> {
  await db.insert(oauthStates).values({
    ...input,
    codeVerifier: input.codeVerifier ? encrypt(input.codeVerifier) : null,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
}

/**
 * Consume a `state` nonce: return its row and delete it (single-use). Returns
 * null if unknown or expired. Opportunistically sweeps expired rows so the table
 * stays bounded without a separate cron.
 */
export async function consumeOAuthState(state: string): Promise<OAuthStateRow | null> {
  const now = new Date();
  // Cheap GC of stale unconsumed rows.
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));

  const rows = await db
    .delete(oauthStates)
    .where(eq(oauthStates.state, state))
    .returning({
      conversationId: oauthStates.conversationId,
      instanceId: oauthStates.instanceId,
      provider: oauthStates.provider,
      codeVerifier: oauthStates.codeVerifier,
      expiresAt: oauthStates.expiresAt,
    });

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null; // expired between sweep and delete
  return {
    conversationId: row.conversationId,
    instanceId: row.instanceId,
    provider: row.provider,
    codeVerifier: row.codeVerifier ? decrypt(row.codeVerifier) : null,
  };
}
