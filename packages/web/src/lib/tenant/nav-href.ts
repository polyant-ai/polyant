// SPDX-License-Identifier: AGPL-3.0-or-later

import { orgPath, workspacePath } from "./paths";

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
