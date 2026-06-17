// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Org-membership provisioning used by the Auth.js callbacks (see `auth.ts`).
 *
 * The actual SQL lives in `auth.ts` (it owns the Drizzle/postgres-js client);
 * this module holds the provider-agnostic orchestration so it can be unit
 * tested without a live database. Callers supply an {@link OrgProvisioningPort}
 * that wraps the few queries we need.
 *
 * Mirrors the engine-side store (`organizations.store.ts`:
 * `ensureDefaultMembership` / `ensureOwnerBinding`) but runs at sign-in /
 * user-creation time so a new OAuth user lands in the default org as Owner
 * automatically — closing the first-registrant race the migration backfill
 * only covered for pre-existing users.
 */

/** The minimal DB capabilities org-provisioning needs, kept SQL-free for tests. */
export interface OrgProvisioningPort {
  /** UUID of the single default organization, or null if the seed is missing. */
  findDefaultOrgId(): Promise<string | null>;
  /** The org a user already belongs to (via membership), or null if none yet. */
  findUserOrgId(userId: string): Promise<string | null>;
  /** UUID of the system "owner" role, or null if the role catalog is missing. */
  findOwnerRoleId(): Promise<string | null>;
  /** Idempotently ensure the user is a member of the org. */
  ensureMembership(organizationId: string, userId: string): Promise<void>;
  /** Idempotently ensure the user holds the org-scope Owner binding. */
  ensureOwnerBinding(
    organizationId: string,
    userId: string,
    ownerRoleId: string,
  ): Promise<void>;
}

/**
 * Place a (typically newly created) user into the default organization as
 * Owner. Idempotent. Returns the resolved org id, or null when no default org
 * exists (a misconfigured/unmigrated deployment — never throws into Auth.js).
 */
export async function provisionUserDefaultOrg(
  port: OrgProvisioningPort,
  userId: string,
): Promise<string | null> {
  const organizationId = await port.findDefaultOrgId();
  if (!organizationId) return null;

  await port.ensureMembership(organizationId, userId);

  const ownerRoleId = await port.findOwnerRoleId();
  if (ownerRoleId) {
    await port.ensureOwnerBinding(organizationId, userId, ownerRoleId);
  }

  return organizationId;
}

/**
 * Resolve the org id to stamp into the JWT at sign-in. Uses the user's existing
 * membership when present; otherwise provisions the default org (covering the
 * race where `events.createUser` has not run yet, or a legacy user predating
 * RBAC). Returns null only when neither a membership nor a default org exists.
 */
export async function resolveSignInOrgId(
  port: OrgProvisioningPort,
  userId: string,
): Promise<string | null> {
  const existing = await port.findUserOrgId(userId);
  if (existing) return existing;

  return provisionUserDefaultOrg(port, userId);
}
