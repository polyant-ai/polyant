// SPDX-License-Identifier: AGPL-3.0-or-later

import { orgPath, workspacePath } from "./paths";
import { defaultWorkspaceSlug } from "./tenant-context";
import type { TenantContextValue } from "./tenant-context";

/** Which tier of the hierarchy a navigation entry belongs to. */
export type NavScope = "workspace" | "org" | "deployment";

/** The tenancy known at render time. Either slug may be absent. */
export interface NavScopeContext {
  orgSlug: string | null;
  workspaceSlug: string | null;
}

/**
 * Build a navigation href for a scope. When the tenancy is not yet resolved a
 * tenant-scoped entry points at `/` — the resolver forwards to the right place,
 * so links stay clickable instead of vanishing and reappearing.
 */
export function navHref(scope: NavScope, path: string, ctx: NavScopeContext): string {
  if (scope === "deployment") return path;
  if (!ctx.orgSlug) return "/";
  if (scope === "org") return orgPath(ctx.orgSlug, path);
  if (!ctx.workspaceSlug) return "/";
  return workspacePath(ctx.orgSlug, ctx.workspaceSlug, path);
}

/**
 * The tenancy a sidebar link should target. The organization always comes from
 * the verified tenancy — /api/me returns exactly one, so a differing URL segment
 * can only be a wrong URL, and following it would leave every link pointing at a
 * tenant that 404s. The workspace segment is honoured when it names a workspace
 * the caller actually holds, since an organization may have several.
 */
export function resolveNavScope(
  tenant: TenantContextValue,
  params: { orgSlug?: string; workspaceSlug?: string },
): NavScopeContext {
  if (tenant.status !== "ready") return { orgSlug: null, workspaceSlug: null };

  const orgSlug = tenant.organization.slug;
  const workspaceSlug =
    params.workspaceSlug && tenant.workspaces.some((w) => w.slug === params.workspaceSlug)
      ? params.workspaceSlug
      : defaultWorkspaceSlug(tenant);

  return { orgSlug, workspaceSlug };
}
