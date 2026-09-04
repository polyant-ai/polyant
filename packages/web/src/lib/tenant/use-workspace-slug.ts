// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useParams } from "next/navigation";
import { defaultWorkspaceSlug, useTenant } from "./tenant-context";

/**
 * The workspace the current page acts in: the URL segment when there is one,
 * otherwise the caller's default (their last-used workspace, else the first they
 * hold).
 *
 * Data-fetching effects use this as their dependency, so a page that lists
 * workspace-scoped rows refetches when the address bar names a different
 * workspace. `api.ts` sends the same answer as `x-workspace-slug`, which is what
 * makes the URL segment authoritative rather than a cookie: a cookie could name
 * a workspace other than the one in the address bar, and the page would then
 * show one workspace's data under another workspace's URL.
 *
 * `null` while the tenancy is still loading — effects should treat that as "not
 * resolved yet", not as "no workspace".
 */
export function useWorkspaceSlug(): string | null {
  const params = useParams<{ workspaceSlug?: string }>();
  const tenant = useTenant();
  return params.workspaceSlug ?? defaultWorkspaceSlug(tenant);
}
