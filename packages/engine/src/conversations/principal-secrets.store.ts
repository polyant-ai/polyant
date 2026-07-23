// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { principalSecrets } from "./principal-secrets.schema.js";
import { encrypt, decrypt } from "../crypto/index.js";

// Only scope in use today; the column exists for a future per-principal tier.
const CONVERSATION_SCOPE = "conversation";

export interface PrincipalSecret {
  value: string;
  expiresAt: Date | null;
}

/** Encrypt and upsert a per-conversation secret (direct write — used by the OAuth
 *  callback and refresh, both outside a pipeline turn, so no commit-on-success
 *  buffering: a fresher token is harmless even if a later turn aborts). */
export async function setPrincipalSecret(
  scopeKey: string,
  instanceId: string | null,
  key: string,
  value: string,
  expiresAt: Date | null = null,
): Promise<void> {
  const encrypted = encrypt(value);
  await db
    .insert(principalSecrets)
    .values({ scope: CONVERSATION_SCOPE, scopeKey, instanceId, key, value: encrypted, expiresAt })
    .onConflictDoUpdate({
      target: [principalSecrets.scope, principalSecrets.scopeKey, principalSecrets.key],
      set: { value: encrypted, expiresAt, updatedAt: new Date() },
    });
}

/** Get + decrypt a single secret, with its expiry. */
export async function getPrincipalSecret(scopeKey: string, key: string): Promise<PrincipalSecret | undefined> {
  const rows = await db
    .select({ value: principalSecrets.value, expiresAt: principalSecrets.expiresAt })
    .from(principalSecrets)
    .where(
      and(
        eq(principalSecrets.scope, CONVERSATION_SCOPE),
        eq(principalSecrets.scopeKey, scopeKey),
        eq(principalSecrets.key, key),
      ),
    )
    .limit(1);
  if (!rows[0]) return undefined;
  return { value: decrypt(rows[0].value), expiresAt: rows[0].expiresAt };
}

export async function deletePrincipalSecret(scopeKey: string, key: string): Promise<void> {
  await db
    .delete(principalSecrets)
    .where(
      and(
        eq(principalSecrets.scope, CONVERSATION_SCOPE),
        eq(principalSecrets.scopeKey, scopeKey),
        eq(principalSecrets.key, key),
      ),
    );
}

/** Keys + expiry for a scope. NEVER returns the (decrypted) values. */
export async function listPrincipalSecretKeys(
  scopeKey: string,
): Promise<Array<{ key: string; expiresAt: Date | null }>> {
  return db
    .select({ key: principalSecrets.key, expiresAt: principalSecrets.expiresAt })
    .from(principalSecrets)
    .where(and(eq(principalSecrets.scope, CONVERSATION_SCOPE), eq(principalSecrets.scopeKey, scopeKey)));
}
