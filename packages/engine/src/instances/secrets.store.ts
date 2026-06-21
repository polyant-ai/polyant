// SPDX-License-Identifier: AGPL-3.0-or-later

import { timingSafeEqual } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { agentSecrets } from "./secrets.schema.js";
import { agents } from "./schema.js";
import { encrypt, decrypt } from "../crypto/index.js";
import { resolveAgentId } from "./resolve-agent-id.js";
import { asAgentUuid, type AgentSlug, type AgentUuid } from "./identifiers.js";

/** Well-known secret key names. */
export const SECRET_KEYS = {
  OPENAI_API_KEY: "openai_api_key",
  ANTHROPIC_API_KEY: "anthropic_api_key",
  AWS_ACCESS_KEY_ID: "aws_access_key_id",
  AWS_SECRET_ACCESS_KEY: "aws_secret_access_key",
  AWS_REGION: "aws_region",
  LANGSMITH_API_KEY: "langsmith_api_key",
  AUTH_API_KEY: "auth_api_key",
  TAVILY_API_KEY: "tavily_api_key",
  GITHUB_TOKEN: "github_token",
  S3_BUCKET_NAME: "s3_bucket_name",
  HTTP_API_KEY: "http_api_key",
  DEEPGRAM_API_KEY: "deepgram_api_key",
} as const;

/** Encrypt and upsert a secret for an instance (by UUID). */
export async function setSecret(agentId: AgentUuid, key: string, value: string): Promise<void> {
  const encrypted = encrypt(value);
  await db
    .insert(agentSecrets)
    .values({ agentId, key, value: encrypted })
    .onConflictDoUpdate({
      target: [agentSecrets.agentId, agentSecrets.key],
      set: { value: encrypted, updatedAt: new Date() },
    });
}

/** Get a single decrypted secret by instance slug + key. */
export async function getSecret(instanceSlug: AgentSlug, key: string): Promise<string | undefined> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return undefined;

  const rows = await db
    .select({ value: agentSecrets.value })
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.key, key)))
    .limit(1);

  return rows[0] ? decrypt(rows[0].value) : undefined;
}

/** Get all decrypted secrets for an instance (by slug). */
export async function getAllSecrets(instanceSlug: AgentSlug): Promise<Record<string, string>> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return {};

  const rows = await db
    .select({ key: agentSecrets.key, value: agentSecrets.value })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentId));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = decrypt(row.value);
  }
  return result;
}

/** Get all decrypted secrets for an instance (by UUID). */
export async function getAllSecretsById(agentId: AgentUuid): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: agentSecrets.key, value: agentSecrets.value })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentId));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = decrypt(row.value);
  }
  return result;
}

/** List secret key names + configured status (never exposes values). */
export async function listSecretKeys(instanceSlug: AgentSlug): Promise<Array<{ key: string; configured: boolean }>> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return [];

  const rows = await db
    .select({ key: agentSecrets.key })
    .from(agentSecrets)
    .where(eq(agentSecrets.agentId, agentId));

  const configuredKeys = new Set(rows.map((r) => r.key));
  const wellKnown = new Set<string>(Object.values(SECRET_KEYS));

  // Include well-known keys (always shown) + any extra keys stored in DB (e.g. tool secrets)
  const result: Array<{ key: string; configured: boolean }> = Object.values(SECRET_KEYS).map((key) => ({
    key,
    configured: configuredKeys.has(key),
  }));

  for (const key of configuredKeys) {
    if (!wellKnown.has(key)) {
      result.push({ key, configured: true });
    }
  }

  return result;
}

/** Delete a secret by instance UUID + key. */
export async function deleteSecret(agentId: AgentUuid, key: string): Promise<void> {
  await db
    .delete(agentSecrets)
    .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.key, key)));
}

/**
 * Find an instance whose `auth_api_key` secret equals the provided token.
 *
 * Iterates every active instance with an `auth_api_key` row, decrypts each
 * value, and compares with `timingSafeEqual` so the comparison itself is not
 * leaky. Linear scan is acceptable at our cardinality (few dozen agents at
 * most); callers must not invoke this on hot paths without their own cache.
 *
 * Returns the matched instance slug or `null` when no key matches.
 */
export async function findInstanceByAuthApiKey(token: string): Promise<{ slug: string; agentId: AgentUuid } | null> {
  if (!token) return null;

  const rows = await db
    .select({
      slug: agents.slug,
      agentId: agents.id,
      value: agentSecrets.value,
    })
    .from(agentSecrets)
    .innerJoin(agents, eq(agents.id, agentSecrets.agentId))
    .where(and(
      eq(agentSecrets.key, SECRET_KEYS.AUTH_API_KEY),
      eq(agents.status, "active"),
    ));

  const tokBuf = Buffer.from(token, "utf-8");
  let match: { slug: string; agentId: AgentUuid } | null = null;

  for (const row of rows) {
    let plaintext: string;
    try {
      plaintext = decrypt(row.value);
    } catch {
      // Skip rows we can't decrypt (e.g. key rotation in progress) — never
      // throw, since that would let an attacker probe per-row failures by
      // measuring response codes.
      continue;
    }
    const expBuf = Buffer.from(plaintext, "utf-8");
    if (tokBuf.length === expBuf.length && timingSafeEqual(tokBuf, expBuf)) {
      // Don't early-return: keep iterating to keep the wall-clock time
      // independent of which row matched.
      match = { slug: row.slug, agentId: asAgentUuid(row.agentId) };
    }
  }

  return match;
}
