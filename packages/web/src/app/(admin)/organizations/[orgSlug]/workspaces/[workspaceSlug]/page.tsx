// SPDX-License-Identifier: AGPL-3.0-or-later

import { redirect } from "next/navigation";
import { workspacePath } from "@/lib/tenant/paths";

/**
 * A workspace has no landing page of its own — the agents list is its home.
 * Redirects server-side, unvalidated: `TenantScopeGuard` is a client component
 * that validates slugs against the fetched tenancy, but this `redirect()`
 * throws during the server render, before that client-side check can run. A
 * bad slug still ends up 404ing — just one level deeper, at `.../agents`,
 * where the guard runs.
 */
export default async function WorkspaceIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspacePath(orgSlug, workspaceSlug, "/agents"));
}
