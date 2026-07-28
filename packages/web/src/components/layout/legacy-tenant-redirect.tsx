// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantUnavailable } from "./tenant-unavailable";
import { useTenant, defaultWorkspaceSlug } from "@/lib/tenant/tenant-context";
import { orgPath, workspacePath } from "@/lib/tenant/paths";

/**
 * Forwards a pre-tenancy URL to its canonical form, preserving the query string
 * (`/conversations?id=…` is a real inbound link). Deep links are what people
 * bookmark, so these stubs exist for one release before removal.
 */
export function LegacyTenantRedirect({
  sub,
  scope = "workspace",
}: {
  sub: string;
  scope?: "workspace" | "org";
}) {
  const tenant = useTenant();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (tenant.status !== "ready") return;

    const query = searchParams.toString();
    const suffix = query ? `${sub}?${query}` : sub;

    if (scope === "org") {
      router.replace(orgPath(tenant.organization.slug, suffix));
      return;
    }

    const workspaceSlug = defaultWorkspaceSlug(tenant);
    if (!workspaceSlug) return;
    router.replace(workspacePath(tenant.organization.slug, workspaceSlug, suffix));
  }, [tenant, router, searchParams, sub, scope]);

  if (tenant.status === "loading" || tenant.status === "ready") {
    return <Skeleton className="h-64 w-full" />;
  }
  return <TenantUnavailable />;
}
