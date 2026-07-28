// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { orgPath, workspacePath } from "./paths";

export interface TenantPaths {
  workspace: (sub: string) => string;
  org: (sub?: string) => string;
}

/**
 * Tenant paths for components that already live inside a workspace route: both
 * slugs are present in the URL synchronously, and the layout guard above has
 * already validated them. No fetch, no null case.
 *
 * Called from anywhere else, `useParams` silently returns `undefined` for both
 * — Next.js does not guarantee the type parameter at runtime — which would
 * build a dead `/organizations/undefined/workspaces/undefined/…` link with no
 * error. Throw instead, so the mistake surfaces at development time.
 */
export function useTenantPaths(): TenantPaths {
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();
  const { orgSlug, workspaceSlug } = params;

  if (!orgSlug || !workspaceSlug) {
    const missing = [!orgSlug && "orgSlug", !workspaceSlug && "workspaceSlug"]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `useTenantPaths: missing required param(s) [${missing}] — must be used within a route that has both orgSlug and workspaceSlug`,
    );
  }

  return useMemo(
    () => ({
      workspace: (sub: string) => workspacePath(orgSlug, workspaceSlug, sub),
      org: (sub?: string) => orgPath(orgSlug, sub),
    }),
    [orgSlug, workspaceSlug],
  );
}
