// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single place the tenant URL shape is written down:
 *
 *   /organizations/{orgSlug}/workspaces/{workspaceSlug}{sub}
 *
 * Pure functions — no React, no hooks — so components, redirects and tests all
 * share one definition. Only the slugs are encoded; `sub` is passed through so
 * callers can append an already-encoded path plus a query string.
 *
 * The client SENDS the workspace the URL names — `request()` reads it back with
 * `workspaceSlugFromPath` and puts it on `X-Workspace-Slug` — but no route in this
 * build reads that header yet, so a workspace-scoped URL still isolates nothing
 * here. The plumbing is in place so that the segment, and not a cookie or a
 * cached "active workspace", is what a future scoping reads: two notions of the
 * current workspace is how a link and a request come to disagree.
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

const WORKSPACE_SEGMENT = /^(\/organizations\/[^/]+\/workspaces\/)([^/]+)(.*)$/;

/**
 * Re-point a workspace-scoped pathname at another workspace, keeping the rest of
 * the path (and the org segment) as-is. Returns `null` when `pathname` is not
 * workspace-scoped — an org-level or deployment-level page has no segment to
 * swap, so its caller must not navigate.
 */
export function withWorkspaceSlug(pathname: string, workspaceSlug: string): string | null {
  const match = WORKSPACE_SEGMENT.exec(pathname);
  if (!match) return null;
  return `${match[1]}${encodeURIComponent(workspaceSlug)}${match[3]}`;
}

/**
 * The workspace a pathname addresses, or `null` on an org-level or
 * deployment-level path. This is what the API client sends as
 * `x-workspace-slug`, which is what makes the segment authoritative — so it must
 * read the URL and nothing else (no cookie, no cached "active" workspace, which
 * is exactly how the two could diverge).
 *
 * Decoded, because the segment is percent-encoded on the way in and the header
 * carries the raw slug.
 */
export function workspaceSlugFromPath(pathname: string): string | null {
  const segment = WORKSPACE_SEGMENT.exec(pathname)?.[2];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not a workspace name — let the request go unscoped
    // and be resolved by the caller's preference rather than throwing here.
    return null;
  }
}
