// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single place the tenant URL shape is written down:
 *
 *   /organizations/{orgSlug}/workspaces/{workspaceSlug}{sub}
 *
 * Pure functions — no React, no hooks — so components, redirects and tests all
 * share one definition. Only the slugs are encoded; `sub` is passed through so
 * callers can append an already-encoded path plus a query string.
 */

/** Reserved for the future platform management console (deployment scope). */
export const PLATFORM_PREFIX = "/platform";

function joinSub(base: string, sub?: string): string {
  if (!sub || sub === "/") return base;
  return sub.startsWith("/") ? `${base}${sub}` : `${base}/${sub}`;
}

/** Organization-scoped path: `/organizations/{orgSlug}{sub}`. */
export function orgPath(orgSlug: string, sub?: string): string {
  return joinSub(`/organizations/${encodeURIComponent(orgSlug)}`, sub);
}

/** Workspace-scoped path: `/organizations/{org}/workspaces/{ws}{sub}`. */
export function workspacePath(
  orgSlug: string,
  workspaceSlug: string,
  sub?: string,
): string {
  const base = `${orgPath(orgSlug)}/workspaces/${encodeURIComponent(workspaceSlug)}`;
  return joinSub(base, sub);
}
