// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Web-side port of the engine's `auth/user-role.ts` — same reason
 * `lib/alb-oidc.ts` ports `parseAlbOidcData`: the two packages share no code, so
 * the vocabulary is mirrored rather than imported.
 *
 * The platform-admin role value used to be `superadmin` and is `platform_admin`
 * now. The web needs the read tolerance just as much as the engine does: the
 * session is a 30-day Auth.js JWT with no revocation, so a `role` claim minted
 * before the rename keeps arriving for up to a month. Comparing it against the
 * new literal alone would hide every platform-admin section from someone who
 * still has every one of those powers.
 */

/** The role vocabulary as persisted and as sent over the wire. */
export type UserRole = "platform_admin" | "user";

/**
 * A role as it may actually ARRIVE — from an Auth.js session token minted before
 * the rename, which keeps arriving for up to the 30-day JWT lifetime.
 *
 * Distinct from `UserRole` on purpose: `UserRole` is what we WRITE, this is what
 * we must be prepared to READ. Declaring the session's `role` as the narrow type
 * would have the compiler assert something about live tokens that is not true.
 * Compare with either spelling only through `isPlatformAdminRole`.
 */
export type PersistedUserRole = UserRole | typeof LEGACY_PLATFORM_ADMIN_ROLE;

/** The canonical platform-admin role value. The ONLY value ever written. */
export const PLATFORM_ADMIN_ROLE = "platform_admin" as const;

/**
 * The pre-rename spelling, still ACCEPTED on read.
 *
 * COMPATIBILITY SHIM — one release. Deletable once every issued session token
 * has been re-minted (past the 30-day JWT expiry from the deploy that shipped
 * the rename) and engine migration 0071 has been applied everywhere. Deleting it
 * earlier makes the panel silently drop every platform-admin-only section for
 * anyone still holding a pre-rename session.
 */
export const LEGACY_PLATFORM_ADMIN_ROLE = "superadmin" as const;

/**
 * Whether a role value grants platform-admin standing. The one comparison in the
 * web package; nothing else compares a role against a literal.
 */
export function isPlatformAdminRole(value: string | null | undefined): boolean {
  return value === PLATFORM_ADMIN_ROLE || value === LEGACY_PLATFORM_ADMIN_ROLE;
}

/**
 * Fold any accepted role spelling onto the canonical vocabulary. Anything
 * unrecognised is a plain `user`, the fail-closed answer.
 *
 * Needed wherever a role value has to MATCH a fixed set rather than merely be
 * compared — the role `<Select>` in the user dialogs, whose options are the
 * canonical values: seeding it from a row that still held the legacy spelling
 * rendered an empty control for someone who is in fact a platform admin.
 */
export function normalizeUserRole(value: unknown): UserRole {
  return typeof value === "string" && isPlatformAdminRole(value)
    ? PLATFORM_ADMIN_ROLE
    : "user";
}
