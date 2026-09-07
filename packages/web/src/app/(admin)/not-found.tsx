// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";

/**
 * The admin group's 404 boundary. Without it, `TenantScopeGuard`'s `notFound()`
 * — raised by the ordinary case of a stale bookmark or another tenant's URL —
 * falls through to Next's built-in page: English-only in a bilingual panel, and
 * with no way back.
 *
 * `/` is the link home because it is the root resolver: it reads the caller's
 * own tenancy and forwards, so this page needs no tenancy knowledge itself.
 *
 * NOTE: the response is still HTTP 200 when the guard raises this after
 * hydration — the tenant check is client-side by necessity. Browsers behave
 * correctly; crawlers and uptime checks see 200.
 */
export default function AdminNotFound() {
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h2 className="mt-2 text-lg font-semibold">{t("notFound.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("notFound.description")}
      </p>
      <Button asChild className="mt-6">
        <Link href="/">{t("notFound.action")}</Link>
      </Button>
    </div>
  );
}
