// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Org-membership LOOKUP for the Auth.js callbacks (see `auth.ts`).
 *
 * The actual SQL lives in `auth.ts` (it owns the Drizzle/postgres-js client);
 * this module holds the provider-agnostic orchestration so it can be unit tested
 * without a live database.
 *
 * SIGN-IN NO LONGER PROVISIONS ANYTHING. It used to: a first OAuth sign-in
 * created the default-org membership AND the Owner binding, so passing the
 * sign-in domain allowlist was enough to become an Owner of the organization —
 * the highest role in the product, granted by arrival. On a deployment whose
 * allowlist is a whole company domain, that is every employee.
 *
 * Membership is now granted deliberately, by someone who already holds
 * `org.member:manage`, through `PUT /api/organizations/:orgSlug/members/:userId`
 * (which writes the membership and the binding together). A user who signs in
 * without one gets no `orgId`, and the panel says so instead of quietly handing
 * them the keys.
 */

/** The minimal DB capability this needs, kept SQL-free for tests. */
export interface OrgProvisioningPort {
  /** The org a user belongs to (via membership), or null if none. */
  findUserOrgId(userId: string): Promise<string | null>;
}

/**
 * Resolve the org id to stamp into the JWT at sign-in — a pure LOOKUP.
 *
 * Returns null when the user holds no membership, which is a legitimate answer
 * and not an error: they have signed in successfully and simply belong to no
 * organization yet. The engine answers `organization: null` for such a caller and
 * the panel renders its "no organization" state.
 */
export async function resolveSignInOrgId(
  port: OrgProvisioningPort,
  userId: string,
): Promise<string | null> {
  return port.findUserOrgId(userId);
}
