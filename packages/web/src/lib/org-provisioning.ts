// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Org-membership LOOKUP for the Auth.js callbacks (see `auth.ts`).
 *
 * The actual SQL lives in `auth.ts` (it owns the Drizzle/postgres-js client);
 * this module holds the provider-agnostic orchestration so it can be unit tested
 * without a live database.
 *
 * SIGN-IN NO LONGER PROVISIONS EVERYONE. It used to: a first OAuth sign-in
 * created the default-org membership AND the Owner binding, so passing the
 * sign-in domain allowlist was enough to become an Owner of the organization —
 * the highest role in the product, granted by arrival. On a deployment whose
 * allowlist is a whole company domain, that is every employee.
 *
 * Membership is now granted deliberately, by someone who already holds
 * `org.member:manage`, through `PUT /api/organizations/:orgSlug/members/:userId`
 * (which writes the membership and the binding together). The one exception is
 * the exact identity explicitly configured as `PLATFORM_ADMIN_EMAIL`: the
 * engine performs its idempotent owner bootstrap over its internal channel.
 * A user who matches neither route gets no `orgId`.
 */

/** The minimal DB capability this needs, kept SQL-free for tests. */
export interface OrgProvisioningPort {
  /** The org a user belongs to (via membership), or null if none. */
  findUserOrgId(userId: string): Promise<string | null>;
  /** Bootstrap the exact configured Platform Admin through the engine. */
  ensureConfiguredPlatformAdminOwner(email: string): Promise<string | null>;
}

export interface SignInIdentity {
  userId: string;
  email: string | null | undefined;
  platformAdminEmail?: string;
}

function normalizedEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value || null;
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
  const email = normalizedEmail(identity.email);
  const configuredAdminEmail = normalizedEmail(identity.platformAdminEmail);
  const existingOrganizationId = await port.findUserOrgId(identity.userId);
  if (existingOrganizationId) return existingOrganizationId;

  if (email && configuredAdminEmail === email) {
    try {
      const bootstrappedOrganizationId =
        await port.ensureConfiguredPlatformAdminOwner(email);
      if (bootstrappedOrganizationId) return bootstrappedOrganizationId;
    } catch {
      // The known-missing membership remains a safe result. Re-read once below
      // in case another boot/login completed while the internal call failed.
    }

    return port.findUserOrgId(identity.userId);
  }

  return null;
}
