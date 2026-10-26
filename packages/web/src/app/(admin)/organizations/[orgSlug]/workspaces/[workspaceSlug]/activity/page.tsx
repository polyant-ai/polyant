// SPDX-License-Identifier: AGPL-3.0-or-later

import { redirect } from "next/navigation";
import { workspacePath } from "@/lib/tenant/paths";

/**
 * Activity became the live part of the Monitor. The old address still opens, on the
 * Monitor, so bookmarks and links in old messages keep working.
 */
export default async function ActivityRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspacePath(orgSlug, workspaceSlug, "/monitor"));
}
