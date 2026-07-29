// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";
import { useTenant } from "@/lib/tenant/tenant-context";

/**
 * Rendered instead of tenant-scoped children when the tenancy cannot be
 * established. Two causes, two remedies: a legacy token needs a fresh sign-in,
 * anything else is retryable.
 */
export function TenantUnavailable() {
  const { t } = useI18n();
  const tenant = useTenant();
  const isLegacyToken = tenant.status === "no-organization";

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="text-lg font-semibold">
        {t(isLegacyToken ? "tenant.noOrganization.title" : "tenant.error.title")}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {t(isLegacyToken ? "tenant.noOrganization.description" : "tenant.error.description")}
      </p>
      {isLegacyToken ? (
        <Button className="mt-6" onClick={() => signOut({ callbackUrl: "/login" })}>
          {t("tenant.noOrganization.action")}
        </Button>
      ) : (
        <Button className="mt-6" onClick={tenant.retry}>
          {t("tenant.error.retry")}
        </Button>
      )}
    </div>
  );
}
