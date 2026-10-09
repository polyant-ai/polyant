// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { createLogger } from "../utils/create-logger.js";
import { verifyPassword } from "../users/password.util.js";
import { managementApiKeys } from "./management-api-keys.schema.js";
import type { ServicePrincipal } from "./auth.types.js";
import type { PermissionKey } from "../authz/permissions.js";

const logger = createLogger();
const LOG_PREFIX = "management-api-keys";

/**
 * Token format presented in the `X-Polyant-Key` header. The public `id`
 * selects the row (indexed) and the `secret` is verified against the
 * stored hash. Keeping the id in the token avoids a scan over every key.
 */
const TOKEN_PREFIX = "pk_";
const TOKEN_SEPARATOR = "_";
/** The id is a uuid column; anything else would reach Postgres as a cast error. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedManagementApiKeyToken {
  readonly id: string;
  readonly secret: string;
}

/**
 * Split a raw `pk_<id>_<secret>` token into its parts. Pure and DB-free so a
 * malformed token is rejected before any query. Returns null when the token
 * does not carry both a uuid id and a non-empty secret.
 */
export function parseManagementApiKeyToken(
  raw: string,
): ParsedManagementApiKeyToken | null {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;

  const body = raw.slice(TOKEN_PREFIX.length);
  const separatorIndex = body.indexOf(TOKEN_SEPARATOR);
  if (separatorIndex <= 0) return null;

  const id = body.slice(0, separatorIndex);
  const secret = body.slice(separatorIndex + 1);
  if (!UUID_RE.test(id) || !secret) return null;

  return { id, secret };
}

function isExpired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() <= Date.now();
}

/**
 * How a key's secret is stored: the hex SHA-256 digest, prefixed.
 *
 * The secret is random and high-entropy, so a slow hash adds no resistance to
 * guessing, and bcrypt at cost 12 cost about 250 ms of event-loop time on
 * every request a key authenticated. Keys hashed with bcrypt before this still
 * verify, and are rewritten to this form the first time they do.
 */
const SHA256_PREFIX = "sha256:";

export function hashManagementApiKeySecret(secret: string): string {
  return SHA256_PREFIX + createHash("sha256").update(secret).digest("hex");
}

async function secretMatches(secret: string, keyHash: string): Promise<boolean> {
  if (keyHash.startsWith(SHA256_PREFIX)) {
    const expected = Buffer.from(keyHash.slice(SHA256_PREFIX.length), "hex");
    const actual = createHash("sha256").update(secret).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  // verifyPassword wraps bcrypt.compare and returns false (never throws) on a
  // malformed hash, so a corrupt row degrades to a clean 401 instead of a 500.
  return verifyPassword(secret, keyHash);
}

/**
 * Refresh the key's `last_used_at`, and store `rehash` when the key was still
 * bcrypt. Fire-and-forget: a failure here must never affect the auth decision,
 * so it is logged and swallowed.
 */
function touchLastUsed(id: string, rehash?: string): void {
  db.update(managementApiKeys)
    .set({ lastUsedAt: new Date(), ...(rehash ? { keyHash: rehash } : {}) })
    .where(eq(managementApiKeys.id, id))
    .catch((error: unknown) => {
      logger.warn(LOG_PREFIX, `failed to update last_used_at: ${String(error)}`);
    });
}

/**
 * Validate an `X-Polyant-Key` token and resolve it to a {@link ServicePrincipal}.
 *
 * Returns null (→ 401 upstream) for a malformed token, an unknown id, a secret
 * that does not match, or an expired key. On success it refreshes `last_used_at`
 * (best-effort) and returns the org-scoped principal with its permission set.
 */
export async function validateManagementApiKey(
  rawToken: string,
): Promise<ServicePrincipal | null> {
  const parsed = parseManagementApiKeyToken(rawToken);
  if (!parsed) return null;

  let rows;
  try {
    rows = await db
      .select({
        id: managementApiKeys.id,
        organizationId: managementApiKeys.organizationId,
        keyHash: managementApiKeys.keyHash,
        permissions: managementApiKeys.permissions,
        expiresAt: managementApiKeys.expiresAt,
      })
      .from(managementApiKeys)
      .where(eq(managementApiKeys.id, parsed.id))
      .limit(1);
  } catch (error) {
    logger.error(LOG_PREFIX, `lookup failed: ${String(error)}`);
    return null;
  }

  const key = rows[0];
  if (!key) return null;
  if (isExpired(key.expiresAt)) return null;

  if (!(await secretMatches(parsed.secret, key.keyHash))) return null;

  touchLastUsed(
    key.id,
    key.keyHash.startsWith(SHA256_PREFIX) ? undefined : hashManagementApiKeySecret(parsed.secret),
  );

  return {
    principalType: "service",
    orgId: key.organizationId,
    permissions: new Set<PermissionKey>(key.permissions),
  };
}
