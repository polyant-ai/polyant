// SPDX-License-Identifier: AGPL-3.0-or-later

import { TenantScopeGuard } from "@/components/layout/tenant-scope-guard";

/** Workspace-scoped subtree — validates both segments. */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  return (
    <TenantScopeGuard orgSlug={orgSlug} workspaceSlug={workspaceSlug}>
      {children}
    </TenantScopeGuard>
  );
}
