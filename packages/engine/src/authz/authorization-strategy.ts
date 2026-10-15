// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentScope, EffectiveBinding } from "./authz.store.js";
import type { PermissionKey } from "./permissions.js";

const NO_PERMISSIONS: ReadonlySet<PermissionKey> = new Set();

/**
 * The permissions a user holds in a scope, using most-specific-wins resolution
 * (design §4.3):
 *
 *   1. If a workspace-scoped binding exists for the target workspace, that
 *      binding's permission set is authoritative — it both grants permissions
 *      the org binding lacks AND revokes permissions the org binding grants.
 *   2. Otherwise the agent inherits the organization-scoped binding.
 *   3. No applicable binding → no permissions (empty → deny is the default
 *      everywhere).
 *
 * Pure and synchronous: bindings are loaded by the service/cache, the decision
 * itself is an in-memory set lookup. Bindings for other orgs/workspaces are
 * ignored — tenant isolation is enforced before they ever reach here, but the
 * scope filter here is a defence-in-depth second gate.
 *
 * The one place the rule is written: `resolvePermission` asks it for one
 * permission, and a caller that needs the whole set (the access read-model, a
 * grant check) asks it for all of them, so they cannot disagree.
 */
export function effectivePermissions(
  bindings: readonly EffectiveBinding[],
  scope: AgentScope,
): ReadonlySet<PermissionKey> {
  const workspaceBinding = bindings.find(
    (b) => b.scopeType === "workspace" && b.scopeId === scope.workspaceId,
  );
  if (workspaceBinding) return workspaceBinding.permissions;

  const orgBinding = bindings.find(
    (b) => b.scopeType === "organization" && b.scopeId === scope.organizationId,
  );
  return orgBinding ? orgBinding.permissions : NO_PERMISSIONS;
}

/** Decide a single permission against a user's effective bindings. */
export function resolvePermission(
  bindings: readonly EffectiveBinding[],
  scope: AgentScope,
  permission: PermissionKey,
): boolean {
  return effectivePermissions(bindings, scope).has(permission);
}
