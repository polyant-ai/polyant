// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../database/client.js";
import { instanceSecrets } from "./secrets.schema.js";
import { instances } from "./schema.js";
import { encrypt, decrypt, lookupDigest } from "../crypto/index.js";
import { resolveInstanceId } from "./resolve-instance-id.js";
import { asInstanceUuid, type InstanceSlug, type InstanceUuid } from "./identifiers.js";

/** Well-known secret key names. */
export const SECRET_KEYS = {
  OPENAI_API_KEY: "openai_api_key",
  ANTHROPIC_API_KEY: "anthropic_api_key",
  NEBIUS_API_KEY: "nebius_api_key",
  BEDROCK_API_KEY: "bedrock_api_key",
  // AWS credentials for the AI provider (Bedrock chat + embedder, AWS/Transcribe STT).
  // Dedicated namespace, intentionally distinct from the generic aws_* keys that
  // attachment storage and tools declare — so the provider and the bucket can use
  // different AWS accounts without sharing a single secret slot.
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

/**
 * The stored columns for a secret: the value encrypted, and the lookup digest
 * when the key authenticates requests. Every writer of `instance_secrets` uses
 * it, so a replaced key never keeps the digest of the value it replaced.
 */
export function secretColumns(key: string, value: string): { value: string; lookupDigest: string | null } {
  return {
    value: encrypt(value),
    lookupDigest: key === SECRET_KEYS.AUTH_API_KEY ? lookupDigest(value) : null,
  };
}

/** Encrypt and upsert a secret for an instance (by UUID). */
export async function setSecret(instanceId: InstanceUuid, key: string, value: string): Promise<void> {
  const columns = secretColumns(key, value);
  await db
    .insert(instanceSecrets)
    .values({ instanceId, key, ...columns })
    .onConflictDoUpdate({
      target: [instanceSecrets.instanceId, instanceSecrets.key],
      set: { ...columns, updatedAt: new Date() },
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
  return getAllSecretsById(instanceId);
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
 * Find the active instance whose `auth_api_key` secret equals the provided token.
 *
 * One indexed lookup by the token's keyed digest: no stored key is decrypted, so
 * the cost does not grow with the number of agents and a wrong token costs what
 * a right one does. A row written before the digest existed has none; the same
 * query returns it, and it is decrypted once and given its digest, so the next
 * lookup no longer reads it.
 *
 * A token two agents share names neither: it answers `null`.
 */
export async function findInstanceByAuthApiKey(token: string): Promise<{ slug: string; instanceId: InstanceUuid } | null> {
  if (!token) return null;
  const digest = lookupDigest(token);

  const rows = await db
    .select({
      id: instanceSecrets.id,
      slug: instances.slug,
      instanceId: instances.id,
      value: instanceSecrets.value,
      lookupDigest: instanceSecrets.lookupDigest,
    })
    .from(instanceSecrets)
    .innerJoin(instances, eq(instances.id, instanceSecrets.instanceId))
    .where(and(
      eq(instanceSecrets.key, SECRET_KEYS.AUTH_API_KEY),
      eq(instances.status, "active"),
      or(eq(instanceSecrets.lookupDigest, digest), isNull(instanceSecrets.lookupDigest)),
    ));

  const matches: { slug: string; instanceId: InstanceUuid }[] = [];
  for (const row of rows) {
    let rowDigest = row.lookupDigest;
    if (rowDigest === null) {
      try {
        rowDigest = lookupDigest(decrypt(row.value));
      } catch {
        // A row that cannot be decrypted (e.g. key rotation in progress) is
        // skipped, never thrown: per-row failures must not show in responses.
        continue;
      }
      await db
        .update(instanceSecrets)
        .set({ lookupDigest: rowDigest })
        .where(and(eq(instanceSecrets.id, row.id), isNull(instanceSecrets.lookupDigest)));
    }
    if (rowDigest === digest) matches.push({ slug: row.slug, instanceId: asInstanceUuid(row.instanceId) });
  }

  return matches.length === 1 ? matches[0] : null;
}
