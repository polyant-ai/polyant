// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyPlaygroundPage() {
  return <LegacyTenantRedirect sub="/playground" />;
}
