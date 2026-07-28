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
 */
export function useTenantPaths(): TenantPaths {
  const { orgSlug, workspaceSlug } = useParams<{
    orgSlug: string;
    workspaceSlug: string;
  }>();

  return useMemo(
    () => ({
      workspace: (sub: string) => workspacePath(orgSlug, workspaceSlug, sub),
      org: (sub?: string) => orgPath(orgSlug, sub),
    }),
    [orgSlug, workspaceSlug],
  );
}
