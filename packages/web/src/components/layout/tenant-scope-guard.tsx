// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { notFound } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { useTenant } from "@/lib/tenant/tenant-context";
import { validateTenantParams } from "@/lib/tenant/validate";
import { TenantUnavailable } from "./tenant-unavailable";

/**
 * Gates a tenant-scoped subtree. Children never mount with unvalidated params:
 * until the tenancy is known we render a skeleton, and a URL addressing someone
 * else's tenant is a 404 rather than a page wrapped in the wrong chrome.
 */
export function TenantScopeGuard({
  orgSlug,
  workspaceSlug,
  children,
}: {
  orgSlug: string;
  workspaceSlug?: string;
  children: React.ReactNode;
}) {
  const tenant = useTenant();

  if (tenant.status === "loading") {
    return <Skeleton className="h-64 w-full" />;
  }

  if (tenant.status !== "ready") {
    return <TenantUnavailable />;
  }

  const scope = { organization: tenant.organization, workspaces: tenant.workspaces };
  if (!validateTenantParams(scope, orgSlug, workspaceSlug)) {
    notFound();
  }

  return <>{children}</>;
}
