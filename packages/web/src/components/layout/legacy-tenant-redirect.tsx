// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { notFound, useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantUnavailable } from "./tenant-unavailable";
import { useTenant, defaultWorkspaceSlug } from "@/lib/tenant/tenant-context";
import { orgPath, workspacePath } from "@/lib/tenant/paths";

/**
 * Forwards a pre-tenancy URL to its canonical form, preserving the query string
 * (`/conversations?id=…` is a real inbound link). Deep links are what people
 * bookmark, so these stubs exist for one release before removal (no issue
 * number tracks this yet — do not let it be forgotten).
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

  if (tenant.status === "ready" && scope !== "org" && defaultWorkspaceSlug(tenant) === null) {
    // No workspace to redirect into — a hang here is a silent dead end, not a
    // real "predates organizations" or "server didn't answer" state, so
    // TenantUnavailable would lie. 404 is the truthful outcome.
    notFound();
  }

  if (tenant.status === "loading" || tenant.status === "ready") {
    return <Skeleton className="h-64 w-full" />;
  }
  return <TenantUnavailable />;
}
