// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AuthorizationService } from "./authorization.service.js";
import type { AgentScope } from "./authz.store.js";
import type { PermissionKey } from "./permissions.js";

/** A human user acting within (at most) one organization. */
export interface UserPermissionPrincipal {
  readonly userId: string;
  readonly orgId?: string;
}

/**
 * Why a decision came out the way it did. `unresolved_scope` and
 * `cross_org` both mean "no agent of yours by that slug" to a caller; they are
 * kept apart for the log line only.
 */
export type UserPermissionReason =
  | "platform_admin"
  | "permission_check"
  | "unresolved_scope"
  | "cross_org";

export interface UserPermissionDecision {
  readonly allowed: boolean;
  readonly reason: UserPermissionReason;
}

/**
 * The permission decision for a human user, shared by the HTTP permission guard
 * and every caller that authorizes a user outside a decorated route. One
 * function, so no caller decides more loosely than the route it mirrors.
 *
 *   1. A Platform Admin (DB-backed, never a token claim) is allowed.
 *   2. An agent-addressed action resolves the agent's workspace+org scope; an
 *      action without an agent acts at the caller's organization level. No
 *      scope at all denies.
 *   3. A caller whose organization differs from the target's is denied.
 *   4. The user's role bindings decide.
 */
export async function decideUserPermission(
  authz: Pick<AuthorizationService, "isPlatformAdmin" | "can" | "resolveAgentScope">,
  principal: UserPermissionPrincipal,
  permission: PermissionKey,
  agentSlug?: string,
  addressedAgentScope?: AgentScope,
): Promise<UserPermissionDecision> {
  if (await authz.isPlatformAdmin(principal.userId)) {
    return { allowed: true, reason: "platform_admin" };
  }

  let scope: AgentScope | null;
  if (agentSlug) {
    scope = addressedAgentScope ?? (await authz.resolveAgentScope(agentSlug));
  } else if (principal.orgId) {
    scope = { agentId: "", workspaceId: "", organizationId: principal.orgId };
  } else {
    scope = null;
  }
  if (!scope) return { allowed: false, reason: "unresolved_scope" };

  if (principal.orgId && principal.orgId !== scope.organizationId) {
    return { allowed: false, reason: "cross_org" };
  }

  const allowed = await authz.can(principal.userId, scope, permission);
  return { allowed, reason: "permission_check" };
}
