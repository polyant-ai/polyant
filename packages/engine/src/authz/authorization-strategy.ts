// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentScope, EffectiveBinding } from "./authz.store.js";
import type { PermissionKey } from "./permissions.js";

/**
 * Decide a single permission against a user's effective bindings using
 * most-specific-wins resolution (design §4.3):
 *
 *   1. If a workspace-scoped binding exists for the target workspace, that
 *      binding's permission set is authoritative — it both grants permissions
 *      the org binding lacks AND revokes permissions the org binding grants.
 *   2. Otherwise the agent inherits the organization-scoped binding.
 *   3. No applicable binding → DENY (empty → deny is the default everywhere).
 *
 * Pure and synchronous: bindings are loaded by the service/cache, the decision
 * itself is an in-memory set lookup. Bindings for other orgs/workspaces are
 * ignored — tenant isolation is enforced before they ever reach here, but the
 * scope filter here is a defence-in-depth second gate.
 */
export function resolvePermission(
  bindings: readonly EffectiveBinding[],
  scope: AgentScope,
  permission: PermissionKey,
): boolean {
  const workspaceBinding = bindings.find(
    (b) => b.scopeType === "workspace" && b.scopeId === scope.workspaceId,
  );
  if (workspaceBinding) {
    return workspaceBinding.permissions.has(permission);
  }

  const orgBinding = bindings.find(
    (b) => b.scopeType === "organization" && b.scopeId === scope.organizationId,
  );
  if (orgBinding) {
    return orgBinding.permissions.has(permission);
  }

  return false;
}

/**
 * Pluggable authorization back-end. The OSS strategy resolves against the
 * built-in system roles; an Enterprise strategy can layer custom roles,
 * attribute conditions, etc. Selected once at boot by the
 * `AUTHORIZATION_STRATEGY` factory — never via runtime dynamic import.
 */
export interface AuthorizationStrategy {
  readonly name: "oss" | "ee";
  resolve(
    bindings: readonly EffectiveBinding[],
    scope: AgentScope,
    permission: PermissionKey,
  ): boolean;
}

/** Injection token for the active AuthorizationStrategy. */
export const AUTHORIZATION_STRATEGY = Symbol("AUTHORIZATION_STRATEGY");

/** OSS authorization: pure most-specific-wins over the seeded system roles. */
export class OssStrategy implements AuthorizationStrategy {
  readonly name = "oss" as const;

  resolve(
    bindings: readonly EffectiveBinding[],
    scope: AgentScope,
    permission: PermissionKey,
  ): boolean {
    return resolvePermission(bindings, scope, permission);
  }
}

/**
 * Factory selecting the authorization strategy at module-construction time.
 * Today only the OSS strategy exists; the EE build replaces this provider (no
 * dynamic import, no runtime branching in the hot path).
 */
export function createAuthorizationStrategy(): AuthorizationStrategy {
  return new OssStrategy();
}
