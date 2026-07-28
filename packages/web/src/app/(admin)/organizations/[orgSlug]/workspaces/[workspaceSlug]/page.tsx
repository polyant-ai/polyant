// SPDX-License-Identifier: AGPL-3.0-or-later

import { redirect } from "next/navigation";
import { workspacePath } from "@/lib/tenant/paths";

/**
 * A workspace has no landing page of its own — the agents list is its home.
 * Redirects server-side: the slugs come from the URL and the layout above has
 * already validated them, so no tenant fetch is needed.
 */
export default async function WorkspaceIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspacePath(orgSlug, workspaceSlug, "/instances"));
}
