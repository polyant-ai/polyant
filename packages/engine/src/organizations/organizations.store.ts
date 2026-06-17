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

export const DEFAULT_ORG_SLUG = "default";

/** Anything that can run a `select` — the shared `db` or a transaction handle. */
type Executor = Pick<typeof db, "select">;

/**
 * Resolve the UUID of the default workspace seeded by migration 0050. Accepts a
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
      "No default workspace found — run migration 0050 before creating instances.",
    );
  }
  return row.id;
}

/** Count of users in the deployment (0 = fresh install). */
export async function countUsers(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  return row?.count ?? 0;
}

/** The single default organization seeded by migration 0050, if present. */
export async function findDefaultOrganization(): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.isDefault, true))
    .limit(1);
  return row ?? null;
}

/** Promote a user to Platform Superadmin by email. No-op when the email is
 *  unknown. Returns the number of rows updated (0 or 1). */
export async function promotePlatformAdminByEmail(email: string): Promise<number> {
  const updated = await db
    .update(users)
    .set({ isPlatformAdmin: true })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  return updated.length;
}

/** Ensure a user has the default-org membership (idempotent). */
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
 *  (idempotent — guarded by an existence check, no unique constraint exists). */
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

  const existing = await db
    .select({ id: roleBindings.id })
    .from(roleBindings)
    .where(
      and(
        eq(roleBindings.userId, userId),
        eq(roleBindings.organizationId, organizationId),
        eq(roleBindings.scopeType, "organization"),
        eq(roleBindings.roleId, ownerRole.id),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(roleBindings).values({
    userId,
    roleId: ownerRole.id,
    scopeType: "organization",
    scopeId: organizationId,
    organizationId,
  });
}
