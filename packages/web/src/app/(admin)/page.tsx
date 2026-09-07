// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantUnavailable } from "@/components/layout/tenant-unavailable";
import { useTenant } from "@/lib/tenant/tenant-context";
import { orgPath } from "@/lib/tenant/paths";

/**
 * The single place that resolves "where does this user land" for a plain `/`
 * visit. The Auth.js `Response.redirect(new URL("/"))` targets converge here,
 * as does an unresolved-tenancy nav href (`navHref` falls back to `/` for a
 * disabled entry). This is why the Edge middleware never needs tenancy
 * knowledge (it could not obtain it — no DB access in the Edge runtime).
 */
export default function AdminRootPage() {
  const tenant = useTenant();
  const router = useRouter();

  useEffect(() => {
    if (tenant.status === "ready") {
      router.replace(orgPath(tenant.organization.slug));
    }
  }, [tenant, router]);

  if (tenant.status === "loading" || tenant.status === "ready") {
    return <Skeleton className="h-64 w-full" />;
  }
  return <TenantUnavailable />;
}
