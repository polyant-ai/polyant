// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";

/**
 * The playground talks to the agent's public chat/stream endpoint, which answers
 * 404 while the agent's Web channel is off. Say so, and point at the switch.
 */
export function WebOffNotice({ instanceSlug }: { instanceSlug: string }) {
  const { t } = useI18n();
  const paths = useTenantPaths();
  return (
    <div className="border-t border-border bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
      {t("playground.webOff")}{" "}
      <Link
        href={paths.workspace(`/instances/${encodeURIComponent(instanceSlug)}?tab=channels`)}
        className="font-medium text-foreground underline underline-offset-2"
      >
        {t("playground.webOffLink")}
      </Link>
    </div>
  );
}
