// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Org-membership LOOKUP for the Auth.js callbacks (see `auth.ts`).
 *
 * The actual SQL lives in `auth.ts` (it owns the Drizzle/postgres-js client);
 * this module holds the orchestration so it can be unit tested without a live
 * database.
 *
 * SIGN-IN PROVISIONS NOBODY, and the port has ONE read capability and no writes
 * — which is the point, not an accident of the current implementation. It used
 * to provision everyone: a first OAuth sign-in created the default-org
 * membership AND the Owner binding, so passing the sign-in domain allowlist was
 * enough to become an Owner of the organization. On a deployment whose allowlist
 * was a whole company domain, that was every employee.
 *
 * It then kept ONE exception, for the identity configured as
 * `PLATFORM_ADMIN_EMAIL`, which called the engine's owner bootstrap over the
 * internal channel — because a federated identity could first appear AFTER the
 * boot that would otherwise have promoted it. That case cannot arise any more:
 * there is no federated provider, so an account exists only because the seeder
 * created it (already a platform admin, made Owner by
 * `organizations/bootstrap.ts` on the same boot) or because an administrator
 * created it deliberately. The exception, its port capability and the engine
 * endpoint behind it are gone with the variable.
 *
 * Membership is granted through `PUT /api/organizations/:orgSlug/members/:userId`
 * by someone holding `org.member:manage`, which writes the membership and the
 * binding together. A user who holds neither gets no `orgId`.
 */

/** The minimal DB capability this needs, kept SQL-free for tests. */
export interface OrgProvisioningPort {
  /** The org a user belongs to (via membership), or null if none. */
  findUserOrgId(userId: string): Promise<string | null>;
}

export interface SignInIdentity {
  userId: string;
}

/**
 * Resolve the org id to stamp into the JWT at sign-in.
 *
 * Returns null when the user holds no membership, which is a legitimate answer
 * and not an error: they have signed in successfully and simply belong to no
 * organization yet. The engine answers `organization: null` for such a caller and
 * the panel renders its "no organization" state.
 */
export async function resolveSignInOrgId(
  port: OrgProvisioningPort,
  identity: SignInIdentity,
): Promise<string | null> {
  return port.findUserOrgId(identity.userId);
}
