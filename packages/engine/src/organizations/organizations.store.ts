// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { users } from "../auth/users.schema.js";
import {
  organizations,
  organizationMemberships,
  workspaces,
} from "./organization.schema.js";
import { roles } from "../authz/role.schema.js";
import { roleBindings } from "../authz/role-binding.schema.js";
import { invalidateSuperadminCache } from "../authz/authz.caches.js";
import { PLATFORM_ADMIN_ROLE } from "../auth/user-role.js";

/** Anything that can run a `select` — the shared `db` or a transaction handle. */
type Executor = Pick<typeof db, "select">;

/**
 * Resolve the UUID of the default workspace seeded by migration 0051. Accepts a
 * transaction handle so callers inside a tx stay consistent. Throws when the
 * seed is missing (migration not run) — the single source of this lookup for
 * the instance create/import paths and tests.
 */
export async function findDefaultWorkspaceId(executor: Executor = db): Promise<string> {
  const [row] = await executor
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.isDefault, true))
    .limit(1);
  if (!row) {
    throw new Error(
      "No default workspace found — run migration 0051 before creating instances.",
    );
  }
  return row.id;
}

/** The single default organization seeded by migration 0051, if present. */
export async function findDefaultOrganization(): Promise<OrganizationIdentity | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.isDefault, true))
    .limit(1);
  return row ?? null;
}

/**
 * Promote a user to Platform Admin by email. No-op when the email is unknown.
 * Returns the number of rows updated (0 or 1).
 *
 * Sets the ROLE as well as the flag. Setting only `is_platform_admin` produced an
 * account that the permission guard grants everything to while `GET /api/users`
 * renders it as an ordinary user — and, because `/api/users/*` is gated by
 * `@RequireRole(platform_admin)`, one that could not open the users admin page it
 * was supposedly an admin of. It also created the `role`/flag divergence that
 * migration 0071 used to "reconcile" by revoking the flag.
 *
 * And it invalidates the platform-admin cache. `AuthorizationService` caches the
 * flag per user with a TTL, so a `false` cached moments earlier would otherwise
 * outlive the promotion. Boot-time promotion usually runs against a cold cache,
 * which is exactly why this was easy to miss — it is the one write of this flag
 * that the invalidate-on-every-write sweep did not cover.
 */
export async function promotePlatformAdminByEmail(email: string): Promise<number> {
  const updated = await db
    .update(users)
    .set({ isPlatformAdmin: true, role: PLATFORM_ADMIN_ROLE, updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  for (const row of updated) invalidateSuperadminCache(row.id);
  return updated.length;
}

/** Ensure a user has the default-org membership (idempotent).
 *  TODO(#109): not yet wired into any user-creation path — see bootstrap.ts. */
export async function ensureDefaultMembership(
  organizationId: string,
  userId: string,
): Promise<void> {
  await db
    .insert(organizationMemberships)
    .values({ organizationId, userId })
    .onConflictDoNothing({
      target: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
    });
}

/** Ensure a user holds the Owner org-scope binding on the default org
 *  (idempotent — relies on the uq_role_bindings_user_role_scope unique index,
 *  so concurrent calls can't create duplicate Owner bindings).
 *  TODO(#109): not yet wired into any user-creation path — see bootstrap.ts.
 *  New users must NOT all become Owner; the default-role policy lands in #109. */
export async function ensureOwnerBinding(
  organizationId: string,
  userId: string,
): Promise<void> {
  const [ownerRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.key, "owner"), eq(roles.isSystem, true)))
    .limit(1);
  if (!ownerRole) return;

  await db
    .insert(roleBindings)
    .values({
      userId,
      roleId: ownerRole.id,
      scopeType: "organization",
      scopeId: organizationId,
      organizationId,
    })
    .onConflictDoNothing({
      target: [
        roleBindings.userId,
        roleBindings.roleId,
        roleBindings.scopeType,
        roleBindings.scopeId,
        roleBindings.organizationId,
      ],
    });
}

/** An organization as the management plane and the frontend URLs address it. */
export interface OrganizationIdentity {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** A workspace as the frontend addresses it in a tenant-scoped URL. */
export interface WorkspaceIdentity {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** Resolve an organization by UUID — the `orgId` the JWT carries. */
export async function findOrganizationById(
  organizationId: string,
): Promise<OrganizationIdentity | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

/** Every workspace in an organization, slug-ordered so the list is stable. */
export async function listWorkspacesByOrganization(
  organizationId: string,
): Promise<WorkspaceIdentity[]> {
  return db
    .select({
      slug: workspaces.slug,
      name: workspaces.name,
      isDefault: workspaces.isDefault,
    })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId))
    .orderBy(workspaces.slug);
}
