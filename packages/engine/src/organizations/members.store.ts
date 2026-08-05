// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { users } from "../auth/users.schema.js";
import { organizations, organizationMemberships } from "./organization.schema.js";
import { roles } from "../authz/role.schema.js";
import { roleBindings, type ScopeType } from "../authz/role-binding.schema.js";
import type { SystemRoleKey } from "../authz/permissions.js";

/** The system Owner role is the one whose loss must be guarded against. */
const OWNER_ROLE_KEY: SystemRoleKey = "owner";

/** Membership management operates only on org-level bindings. */
const ORG_SCOPE: ScopeType = "organization";

/** A member of an organization with the key of their org-scope system role. */
export interface OrganizationMember {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  /** Org-scope system role key (owner/admin/member/viewer), or null if unbound. */
  readonly roleKey: string | null;
}

/** Resolve the UUID of an organization by its slug, or null when unknown. */
export async function resolveOrgIdBySlug(slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

/** A seeded system role by key (e.g. "owner"), or null when the catalog lacks it. */
export async function getSystemRoleByKey(
  roleKey: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.key, roleKey), eq(roles.isSystem, true)))
    .limit(1);
  return row ?? null;
}

/**
 * The org-scope system role key a user currently holds in an organization, or
 * null when they have no organization-scope binding there. Used to decide
 * whether a mutation would touch the last remaining Owner.
 */
export async function getOrgScopeRoleKey(
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ roleKey: roles.key })
    .from(roleBindings)
    .innerJoin(roles, eq(roleBindings.roleId, roles.id))
    .where(
      and(
        eq(roleBindings.userId, userId),
        eq(roleBindings.organizationId, organizationId),
        eq(roleBindings.scopeType, ORG_SCOPE),
      ),
    )
    .limit(1);
  return row?.roleKey ?? null;
}

/** Count the distinct users holding an org-scope Owner binding in an org. */
export async function countOwnerBindings(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${roleBindings.userId})::int` })
    .from(roleBindings)
    .innerJoin(roles, eq(roleBindings.roleId, roles.id))
    .where(
      and(
        eq(roleBindings.organizationId, organizationId),
        eq(roleBindings.scopeType, ORG_SCOPE),
        eq(roles.key, OWNER_ROLE_KEY),
        eq(roles.isSystem, true),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Set a user's org-scope role to exactly `roleId`: drop any existing org-scope
 * bindings for the user in the org, then insert the new one. A single
 * transaction so a member never ends up with two org-scope roles.
 */
export async function upsertOrgScopeBinding(params: {
  organizationId: string;
  userId: string;
  roleId: string;
  actorId?: string;
}): Promise<void> {
  const { organizationId, userId, roleId, actorId } = params;
  await db.transaction(async (tx) => {
    await tx
      .delete(roleBindings)
      .where(
        and(
          eq(roleBindings.userId, userId),
          eq(roleBindings.organizationId, organizationId),
          eq(roleBindings.scopeType, ORG_SCOPE),
        ),
      );
    await tx.insert(roleBindings).values({
      userId,
      roleId,
      scopeType: ORG_SCOPE,
      scopeId: organizationId,
      organizationId,
      createdBy: actorId,
    });
  });
}

/**
 * Remove every org-scope binding a user holds in an organization. Returns
 * whether any row was deleted (false = the user had no org-scope binding).
 */
export async function deleteOrgScopeBinding(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(roleBindings)
    .where(
      and(
        eq(roleBindings.userId, userId),
        eq(roleBindings.organizationId, organizationId),
        eq(roleBindings.scopeType, ORG_SCOPE),
      ),
    )
    .returning({ id: roleBindings.id });
  return deleted.length > 0;
}

/**
 * List the members of an organization with their org-scope role key. One query
 * (no N+1): memberships left-joined to the org-scope binding and its role.
 */
export async function listOrganizationMembers(
  organizationId: string,
): Promise<OrganizationMember[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      roleKey: roles.key,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .leftJoin(
      roleBindings,
      and(
        eq(roleBindings.userId, users.id),
        eq(roleBindings.organizationId, organizationId),
        eq(roleBindings.scopeType, ORG_SCOPE),
      ),
    )
    .leftJoin(roles, eq(roleBindings.roleId, roles.id))
    .where(eq(organizationMemberships.organizationId, organizationId));

  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    roleKey: r.roleKey ?? null,
  }));
}

/**
 * Whether deleting `userId` would leave any organization without an Owner — the
 * user is the sole Owner of at least one org they own. Used by the user-delete
 * path to apply the same Owner-last guard the role-binding mutations enforce.
 *
 * One query: restrict the Owner bindings to the orgs the user owns, group by
 * org, and keep only those with a single distinct Owner. Any such row means the
 * user is that org's last Owner.
 */
export async function isLastOwnerOfAnyOrg(userId: string): Promise<boolean> {
  const ownedOrgIds = db
    .selectDistinct({ organizationId: roleBindings.organizationId })
    .from(roleBindings)
    .innerJoin(roles, eq(roleBindings.roleId, roles.id))
    .where(
      and(
        eq(roleBindings.userId, userId),
        eq(roleBindings.scopeType, ORG_SCOPE),
        eq(roles.key, OWNER_ROLE_KEY),
        eq(roles.isSystem, true),
      ),
    );

  const soleOwnerOrgs = await db
    .select({ organizationId: roleBindings.organizationId })
    .from(roleBindings)
    .innerJoin(roles, eq(roleBindings.roleId, roles.id))
    .where(
      and(
        eq(roleBindings.scopeType, ORG_SCOPE),
        eq(roles.key, OWNER_ROLE_KEY),
        eq(roles.isSystem, true),
        inArray(roleBindings.organizationId, ownedOrgIds),
      ),
    )
    .groupBy(roleBindings.organizationId)
    .having(sql`count(distinct ${roleBindings.userId}) <= 1`)
    .limit(1);

  return soleOwnerOrgs.length > 0;
}
