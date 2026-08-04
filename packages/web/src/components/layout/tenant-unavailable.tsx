// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";
import { useTenant } from "@/lib/tenant/tenant-context";

/**
 * Rendered instead of tenant-scoped children when the tenancy cannot be
 * established. THREE causes, and the remedy differs for each — offering the wrong
 * one is what made an expired session an unrecoverable loop:
 *
 *   - `signed-out`  → the session expired. Sign in again. Retry cannot help,
 *     because `/api/me` will keep answering 401 and the proxy does not bounce
 *     XHRs to `/login`.
 *   - `no-organization` → authenticated, but holding no organization binding.
 *     A fresh sign-in re-runs provisioning, so that is the action.
 *   - anything else → treat as transport, and let the caller retry.
 */
export function TenantUnavailable() {
  const { t } = useI18n();
  const tenant = useTenant();

  if (tenant.status === "signed-out") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h2 className="text-lg font-semibold">{t("tenant.signedOut.title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("tenant.signedOut.description")}</p>
        <Button className="mt-6" onClick={() => signOut({ callbackUrl: "/login" })}>
          {t("tenant.signedOut.action")}
        </Button>
      </div>
    );
  }

  /**
   * Authenticated, but belonging to no organization. There is NO self-service
   * remedy: sign-in used to provision a membership, so "sign in again" was real
   * advice — now that it does not, an administrator has to add the account. So
   * this state offers no button at all rather than one that cannot work.
   */
  if (tenant.status === "no-organization") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h2 className="text-lg font-semibold">{t("tenant.noOrganization.title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("tenant.noOrganization.description")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="text-lg font-semibold">{t("tenant.error.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t("tenant.error.description")}</p>
      <Button className="mt-6" onClick={tenant.retry}>
        {t("tenant.error.retry")}
      </Button>
    </div>
  );
}
