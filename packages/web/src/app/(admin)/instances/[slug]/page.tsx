// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useParams } from "next/navigation";
import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyInstanceDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  return <LegacyTenantRedirect sub={`/instances/${encodeURIComponent(slug)}`} />;
}
