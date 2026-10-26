// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantUnavailable } from "@/components/layout/tenant-unavailable";
import { defaultWorkspaceSlug, useTenant } from "@/lib/tenant/tenant-context";
import { workspacePath } from "@/lib/tenant/paths";

/**
 * The tool-call list moved into the Monitor, which lives in a workspace. This
 * address sits at organization level, so it needs the tenancy to pick the
 * workspace before it can go there; it opens the Monitor narrowed to tool calls.
 */
export default function AuditLogsRedirectPage() {
  const tenant = useTenant();
  const router = useRouter();
  const workspaceSlug = defaultWorkspaceSlug(tenant);

  useEffect(() => {
    if (tenant.status === "ready" && workspaceSlug) {
      router.replace(workspacePath(tenant.organization.slug, workspaceSlug, "/monitor?group=agents&type=tool_call"));
    }
  }, [tenant, workspaceSlug, router]);

  if (tenant.status === "loading" || (tenant.status === "ready" && workspaceSlug)) {
    return <Skeleton className="h-64 w-full" />;
  }
  return <TenantUnavailable />;
}
