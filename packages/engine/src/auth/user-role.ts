// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The deployment-level role vocabulary, and the single place that knows the
 * platform-admin role has had two spellings.
 *
 * `users.role` is plain `text` with no CHECK constraint, so the column has held
 * whatever the code of the day wrote. The value used to be `superadmin`; it is
 * `platform_admin` now, matching the `users.is_platform_admin` column that was
 * always named correctly. Renaming a persisted value has three failure modes
 * that all look identical from the outside — "nobody is an admin any more" —
 * so the rule here is EXPAND THEN CONTRACT: read both spellings, write only the
 * new one.
 *
 *  1. A signed-in web session is a 30-day Auth.js JWT with no revocation, and
 *     its `role` claim was minted before the rename. `normalizeUserRole` folds
 *     it onto the canonical value at the trust boundary
 *     (`auth-user.service.ts`), so every consumer downstream — RoleGuard, the
 *     `@RequireRole` metadata, every comparison — only ever sees the new value.
 *  2. `is_platform_admin` is DERIVED from the role at write time
 *     (`users.store.ts`). An API caller still POSTing the legacy value must
 *     still be granted the flag, or the account is silently not an admin.
 *  3. During a rolling deploy old code meets new data. That is why the
 *     read-tolerant predicate ships BEFORE OR WITH the migration, never after:
 *     old code reading `platform_admin` would treat it as a plain user.
 */

/** The role vocabulary as persisted and as sent over the wire. */
export type UserRole = "platform_admin" | "user";

/** The canonical platform-admin role value. The ONLY value ever written. */
export const PLATFORM_ADMIN_ROLE = "platform_admin" as const;

/**
 * The pre-rename spelling, still ACCEPTED on read.
 *
 * COMPATIBILITY SHIM — one release. Deletable once both are true:
 *   - every issued Auth.js session token has been re-minted, i.e. past the
 *     30-day JWT expiry from the deploy that shipped the rename; and
 *   - migration 0071 has been applied everywhere, so no `users.role` row still
 *     holds it.
 * Deleting it earlier silently demotes every platform admin to a plain user.
 */
export const LEGACY_PLATFORM_ADMIN_ROLE = "superadmin" as const;

/**
 * Every value that means "platform admin", for a DB predicate that has to match
 * rows written on either side of the rename (see `countPlatformAdmins`).
 */
export const PLATFORM_ADMIN_ROLE_VALUES = [
  PLATFORM_ADMIN_ROLE,
  LEGACY_PLATFORM_ADMIN_ROLE,
] as const;

/**
 * Whether a role value — from a DB row, a JWT claim or a request body — grants
 * platform-admin standing. The one comparison in the codebase; nothing else
 * compares a role against a literal.
 */
export function isPlatformAdminRole(value: string | null | undefined): boolean {
  return value === PLATFORM_ADMIN_ROLE || value === LEGACY_PLATFORM_ADMIN_ROLE;
}

/**
 * Fold any accepted role spelling onto the canonical vocabulary. Anything
 * unrecognised — including a malformed or absent claim — is a plain `user`,
 * which is the fail-closed answer.
 */
export function normalizeUserRole(value: unknown): UserRole {
  return typeof value === "string" && isPlatformAdminRole(value)
    ? PLATFORM_ADMIN_ROLE
    : "user";
}
