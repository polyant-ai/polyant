// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { users } from "../auth/users.schema.js";
import { agents } from "../instances/schema.js";
import { workspaces } from "../organizations/organization.schema.js";
import { roleBindings, type ScopeType } from "./role-binding.schema.js";
import { rolePermissions } from "./role.schema.js";
import type { PermissionKey } from "./permissions.js";

/**
 * The resolved tenancy coordinates of an agent (live table: `agents`). The
 * choke-point every scope-bound permission check runs through so an agent slug
 * is translated to its owning workspace + organization exactly once.
 */
export interface AgentScope {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
}

/**
 * A role binding flattened to the fields `can()` needs: which scope it grants
 * over, the scope's id, and the set of permissions the bound role carries.
 * Permissions are pre-expanded from `role_permissions` so the authorization
 * decision is a pure in-memory set lookup.
 */
export interface EffectiveBinding {
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly permissions: ReadonlySet<PermissionKey>;
}

/** Read the `is_platform_admin` flag straight from the users table (no cache). */
export async function readPlatformAdminFlag(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.isPlatformAdmin ?? false;
}

/**
 * Resolve an agent slug to its tenancy scope. Returns `null` when the agent
 * does not exist — the caller decides whether that is a deny or a 404.
 */
export async function readAgentScope(agentSlug: string): Promise<AgentScope | null> {
  const [row] = await db
    .select({
      agentId: agents.id,
      workspaceId: agents.workspaceId,
      organizationId: workspaces.organizationId,
    })
    .from(agents)
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .where(eq(agents.slug, agentSlug))
    .limit(1);
  return row ?? null;
}

/**
 * Load every role binding a user holds within an organization, each with its
 * role's expanded permission set. One query for the bindings, one batched query
 * for the permissions (no N+1).
 */
export async function readUserBindings(
  userId: string,
  organizationId: string,
): Promise<EffectiveBinding[]> {
  const bindings = await db
    .select({
      roleId: roleBindings.roleId,
      scopeType: roleBindings.scopeType,
      scopeId: roleBindings.scopeId,
    })
    .from(roleBindings)
    .where(
      and(
        eq(roleBindings.userId, userId),
        eq(roleBindings.organizationId, organizationId),
      ),
    );
  if (bindings.length === 0) return [];

  const roleIds = [...new Set(bindings.map((b) => b.roleId))];
  const permissionRows = await db
    .select({
      roleId: rolePermissions.roleId,
      permission: rolePermissions.permission,
    })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, roleIds));

  const permissionsByRole = new Map<string, Set<PermissionKey>>();
  for (const { roleId, permission } of permissionRows) {
    const set = permissionsByRole.get(roleId) ?? new Set<PermissionKey>();
    set.add(permission as PermissionKey);
    permissionsByRole.set(roleId, set);
  }

  return bindings.map((b) => ({
    scopeType: b.scopeType,
    scopeId: b.scopeId,
    permissions: permissionsByRole.get(b.roleId) ?? new Set<PermissionKey>(),
  }));
}
