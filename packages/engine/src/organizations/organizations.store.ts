// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { users } from "../auth/users.schema.js";
import {
  organizations,
  organizationMemberships,
  workspaces,
} from "./organization.schema.js";
import { roles } from "../authz/role.schema.js";
import { roleBindings } from "../authz/role-binding.schema.js";
import {
  bindingCache,
  bindingCacheKey,
  invalidateSuperadminCache,
} from "../authz/authz.caches.js";

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
 * Sets only `is_platform_admin` — the single source of platform-admin standing.
 * `/api/users/*` is gated by `@PlatformAdminOnly()`, which `PermissionGuard`
 * resolves straight from this column on every request, so there is no second
 * spelling left to drift out of sync with it.
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
    .set({ isPlatformAdmin: true, updatedAt: new Date() })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  for (const row of updated) invalidateSuperadminCache(row.id);
  return updated.length;
}

/**
 * Establish the one deliberately configured bootstrap identity as an Owner of
 * the default organization. The whole write path is transactional: a caller
 * never observes a promoted platform admin without the membership and binding
 * that make the installation usable.
 *
 * Email comparisons are normalized on both sides. Auth.js normally stores
 * normalized email already, but this also handles legacy rows created before
 * that invariant was enforced.
 */
export async function ensureConfiguredPlatformAdminOwner(
  email: string,
): Promise<string | null> {
  return ensureDefaultOwnerForEmail(email, { promotePlatformAdmin: true });
}

/**
 * Complete the tenancy bootstrap for an already privileged identity only. This
 * is used for the account created by `INITIAL_ADMIN_*`; unlike the configured
 * email path, it can never elevate an arbitrary existing user.
 */
export async function ensureExistingPlatformAdminOwner(
  email: string,
): Promise<string | null> {
  return ensureDefaultOwnerForEmail(email, { promotePlatformAdmin: false });
}

async function ensureDefaultOwnerForEmail(
  email: string,
  options: { promotePlatformAdmin: boolean },
): Promise<string | null> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  const bootstrap = await db.transaction(async (tx) => {
    const [defaultOrg] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.isDefault, true))
      .limit(1);
    if (!defaultOrg) return null;

    const [ownerRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.key, "owner"), eq(roles.isSystem, true)))
      .limit(1);
    if (!ownerRole) return null;

    const [user] = await tx
      .select({ id: users.id, isPlatformAdmin: users.isPlatformAdmin })
      .from(users)
      .where(sql`lower(${users.email}) = ${normalizedEmail}`)
      .limit(1);
    if (!user || (!options.promotePlatformAdmin && !user.isPlatformAdmin)) {
      return null;
    }

    if (options.promotePlatformAdmin) {
      await tx
        .update(users)
        .set({
          isPlatformAdmin: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
    }

    await tx
      .insert(organizationMemberships)
      .values({ organizationId: defaultOrg.id, userId: user.id })
      .onConflictDoNothing({
        target: [
          organizationMemberships.organizationId,
          organizationMemberships.userId,
        ],
      });

    // Owner is the canonical bootstrap role, not an additional org-level grant.
    // Removing all org-scope bindings first prevents a previously assigned
    // admin/member/custom role from surviving alongside it. Workspace-scoped
    // bindings remain untouched: this bootstrap establishes organization
    // ownership, it does not rewrite workspace policy.
    await tx
      .delete(roleBindings)
      .where(
        and(
          eq(roleBindings.userId, user.id),
          eq(roleBindings.organizationId, defaultOrg.id),
          eq(roleBindings.scopeType, "organization"),
        ),
      );

    await tx
      .insert(roleBindings)
      .values({
        userId: user.id,
        roleId: ownerRole.id,
        scopeType: "organization",
        scopeId: defaultOrg.id,
        organizationId: defaultOrg.id,
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

    return { userId: user.id, organizationId: defaultOrg.id };
  });

  if (!bootstrap) return null;

  // Only invalidate after the transaction commits; otherwise a concurrent read
  // can repopulate either cache from the old state.
  if (options.promotePlatformAdmin) invalidateSuperadminCache(bootstrap.userId);
  bindingCache.delete(bindingCacheKey(bootstrap.userId, bootstrap.organizationId));
  return bootstrap.organizationId;
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

/** Whether a user still belongs to an organization. */
export async function isOrganizationMember(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const [membership] = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(membership);
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
