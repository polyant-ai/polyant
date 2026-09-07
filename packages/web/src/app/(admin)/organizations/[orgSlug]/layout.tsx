// SPDX-License-Identifier: AGPL-3.0-or-later

import { TenantScopeGuard } from "@/components/layout/tenant-scope-guard";

/**
 * Organization-scoped subtree. A server component so it can await `params` and
 * hand the guard plain strings.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return <TenantScopeGuard orgSlug={orgSlug}>{children}</TenantScopeGuard>;
}
