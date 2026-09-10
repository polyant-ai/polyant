// SPDX-License-Identifier: AGPL-3.0-or-later

import { ForbiddenException } from "@nestjs/common";
import { orgScope, type TenantScope } from "../../authz/scope-filter.js";
import { resolvePrincipalOrgId } from "../../instances/store.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";

/**
 * The `TenantScope` a request acts in: the caller's organization, resolved.
 *
 * This is the only place a controller turns a principal into a scope, and it
 * REFUSES rather than degrading. The shape it replaced was
 * `(await resolvePrincipalOrgId(user?.orgId)) ?? undefined`, repeated at every
 * call site, which handed the store an absent scope and relied on the store
 * failing closed — so an unresolvable caller got an empty list, and forgetting
 * the argument entirely looked exactly the same.
 *
 * A principal whose organization cannot be resolved is the state
 * `PermissionGuard` already denies ("unresolved scope"); answering `200` with
 * zero rows was a second, weaker copy of that decision. With one organization
 * per deployment `resolvePrincipalOrgId` resolves it even for a principal that
 * carries no claim, so this throws only where there is genuinely no tenant to
 * act in.
 */
export async function callerTenantScope(user: AuthenticatedUser | undefined): Promise<TenantScope> {
  const organizationId = await resolvePrincipalOrgId(user?.orgId);
  if (!organizationId) {
    throw new ForbiddenException("No organization scope could be resolved for this caller");
  }
  return orgScope(organizationId);
}
