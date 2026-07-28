// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TenantContextPayload } from "@/lib/api-types";

/** Just the tenancy fields — the guard holds these without the `user` block. */
export type TenantScope = Pick<TenantContextPayload, "organization" | "workspaces">;

/**
 * True when a URL's tenant segments address the caller's actual tenancy.
 *
 * A mismatch means a hand-edited or stale URL, and the caller renders a 404
 * rather than wrapping the caller's own data in another tenant's chrome. A
 * caller with no organization can address nothing.
 */
export function validateTenantParams(
  scope: TenantScope,
  orgSlug: string,
  workspaceSlug?: string,
): boolean {
  if (!scope.organization) return false;
  if (scope.organization.slug !== orgSlug) return false;
  if (workspaceSlug === undefined) return true;
  return scope.workspaces.some((workspace) => workspace.slug === workspaceSlug);
}
