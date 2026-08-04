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
 * AND the fragment — `/conversations?id=…#msg-7` is a real bookmark, and a
 * fragment names the thing the reader actually wanted. Deep links are what people
 * bookmark, so these stubs exist for one release before removal (no issue
 * number tracks this yet — do not let it be forgotten).
 *
 * The hash comes from `window.location`, not from a hook: fragments are never
 * sent to the server, so Next has no router state for them.
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
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    const suffix = `${sub}${query ? `?${query}` : ""}${hash}`;

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
