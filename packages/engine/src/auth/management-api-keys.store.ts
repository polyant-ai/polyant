// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "../database/client.js";
import { createLogger } from "../utils/create-logger.js";
import { managementApiKeys } from "./management-api-keys.schema.js";
import type { ServicePrincipal } from "./auth.types.js";
import type { PermissionKey } from "../authz/permissions.js";

const logger = createLogger();
const LOG_PREFIX = "management-api-keys";

/**
 * Token format presented in the `X-Polyant-Key` header. The public `id`
 * selects the row (indexed) and the `secret` is bcrypt-verified against the
 * stored hash. Keeping the id in the token avoids a full-table bcrypt scan.
 */
const TOKEN_PREFIX = "pk_";
const TOKEN_SEPARATOR = "_";

export interface ParsedManagementApiKeyToken {
  readonly id: string;
  readonly secret: string;
}

/**
 * Split a raw `pk_<id>_<secret>` token into its parts. Pure and DB-free so a
 * malformed token is rejected before any query. Returns null when the token
 * does not carry both a non-empty id and a non-empty secret.
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
  if (!id || !secret) return null;

  return { id, secret };
}

function isExpired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() <= Date.now();
}

/**
 * Refresh the key's `last_used_at`. Fire-and-forget observability: a failure
 * here must never affect the auth decision, so it is logged and swallowed.
 */
function touchLastUsed(id: string): void {
  db.update(managementApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(managementApiKeys.id, id))
    .catch((error: unknown) => {
      logger.warn(LOG_PREFIX, `failed to update last_used_at: ${String(error)}`);
    });
}

/**
 * Validate an `X-Polyant-Key` token and resolve it to a {@link ServicePrincipal}.
 *
 * Returns null (→ 401 upstream) for a malformed token, an unknown id, a secret
 * that fails bcrypt, or an expired key. On success it refreshes `last_used_at`
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

  let matches: boolean;
  try {
    matches = await bcrypt.compare(parsed.secret, key.keyHash);
  } catch (error) {
    logger.error(LOG_PREFIX, `bcrypt compare failed: ${String(error)}`);
    return null;
  }
  if (!matches) return null;

  touchLastUsed(key.id);

  return {
    principalType: "service",
    orgId: key.organizationId,
    permissions: new Set<PermissionKey>(key.permissions),
  };
}
