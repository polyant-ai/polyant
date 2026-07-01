// SPDX-License-Identifier: AGPL-3.0-or-later

import { timingSafeEqual } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instanceSecrets } from "./secrets.schema.js";
import { instances } from "./schema.js";
import { encrypt, decrypt } from "../crypto/index.js";
import { resolveInstanceId } from "./resolve-instance-id.js";
import { asInstanceUuid, type InstanceSlug, type InstanceUuid } from "./identifiers.js";

/** Well-known secret key names. */
export const SECRET_KEYS = {
  OPENAI_API_KEY: "openai_api_key",
  ANTHROPIC_API_KEY: "anthropic_api_key",
  BEDROCK_API_KEY: "bedrock_api_key",
  // AWS credentials for the AI provider (Bedrock chat + embedder, AWS/Transcribe STT).
  // Dedicated namespace, intentionally distinct from the generic aws_* keys that
  // tools (e.g. file-upload/S3) declare — so the provider and a tool can use different
  // AWS accounts without sharing a single secret slot.
  AWS_PROVIDER_ACCESS_KEY_ID: "aws_provider_access_key_id",
  AWS_PROVIDER_SECRET_ACCESS_KEY: "aws_provider_secret_access_key",
  AWS_PROVIDER_REGION: "aws_provider_region",
  LANGSMITH_API_KEY: "langsmith_api_key",
  AUTH_API_KEY: "auth_api_key",
  TAVILY_API_KEY: "tavily_api_key",
  GITHUB_TOKEN: "github_token",
  S3_BUCKET_NAME: "s3_bucket_name",
  HTTP_API_KEY: "http_api_key",
  DEEPGRAM_API_KEY: "deepgram_api_key",
} as const;

/** Encrypt and upsert a secret for an instance (by UUID). */
export async function setSecret(instanceId: InstanceUuid, key: string, value: string): Promise<void> {
  const encrypted = encrypt(value);
  await db
    .insert(instanceSecrets)
    .values({ instanceId, key, value: encrypted })
    .onConflictDoUpdate({
      target: [instanceSecrets.instanceId, instanceSecrets.key],
      set: { value: encrypted, updatedAt: new Date() },
    });
}

/** Get a single decrypted secret by instance slug + key. */
export async function getSecret(instanceSlug: InstanceSlug, key: string): Promise<string | undefined> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) return undefined;

  const rows = await db
    .select({ value: instanceSecrets.value })
    .from(instanceSecrets)
    .where(and(eq(instanceSecrets.instanceId, instanceId), eq(instanceSecrets.key, key)))
    .limit(1);

  return rows[0] ? decrypt(rows[0].value) : undefined;
}

/** Get all decrypted secrets for an instance (by slug). */
export async function getAllSecrets(instanceSlug: InstanceSlug): Promise<Record<string, string>> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) return {};

  const rows = await db
    .select({ key: instanceSecrets.key, value: instanceSecrets.value })
    .from(instanceSecrets)
    .where(eq(instanceSecrets.instanceId, instanceId));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = decrypt(row.value);
  }
  return result;
}

/** Get all decrypted secrets for an instance (by UUID). */
export async function getAllSecretsById(instanceId: InstanceUuid): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: instanceSecrets.key, value: instanceSecrets.value })
    .from(instanceSecrets)
    .where(eq(instanceSecrets.instanceId, instanceId));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = decrypt(row.value);
  }
  return result;
}

/** List secret key names + configured status (never exposes values). */
export async function listSecretKeys(instanceSlug: InstanceSlug): Promise<Array<{ key: string; configured: boolean }>> {
  const instanceId = await resolveInstanceId(instanceSlug);
  if (!instanceId) return [];

  const rows = await db
    .select({ key: instanceSecrets.key })
    .from(instanceSecrets)
    .where(eq(instanceSecrets.instanceId, instanceId));

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
export async function deleteSecret(instanceId: InstanceUuid, key: string): Promise<void> {
  await db
    .delete(instanceSecrets)
    .where(and(eq(instanceSecrets.instanceId, instanceId), eq(instanceSecrets.key, key)));
}

/**
 * Find an instance whose `auth_api_key` secret equals the provided token.
 *
 * Iterates every active instance with an `auth_api_key` row, decrypts each
 * value, and compares with `timingSafeEqual` so the comparison itself is not
 * leaky. Linear scan is acceptable at our cardinality (few dozen instances at
 * most); callers must not invoke this on hot paths without their own cache.
 *
 * Returns the matched instance slug or `null` when no key matches.
 */
export async function findInstanceByAuthApiKey(token: string): Promise<{ slug: string; instanceId: InstanceUuid } | null> {
  if (!token) return null;

  const rows = await db
    .select({
      slug: instances.slug,
      instanceId: instances.id,
      value: instanceSecrets.value,
    })
    .from(instanceSecrets)
    .innerJoin(instances, eq(instances.id, instanceSecrets.instanceId))
    .where(and(
      eq(instanceSecrets.key, SECRET_KEYS.AUTH_API_KEY),
      eq(instances.status, "active"),
    ));

  const tokBuf = Buffer.from(token, "utf-8");
  let match: { slug: string; instanceId: InstanceUuid } | null = null;

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
      match = { slug: row.slug, instanceId: asInstanceUuid(row.instanceId) };
    }
  }

  return match;
}
