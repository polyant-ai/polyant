// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n/context";

/**
 * The three states every list shares besides its rows. A failed load is
 * `LoadFailed` (components/ui/load-failed.tsx); these are the other two, plus the
 * line for a search that matches nothing.
 */

/** A list with nothing in it: a muted title, what to do about it, and the action that does it. */
export function ListEmpty({
  title,
  description,
  action,
  className = "mt-16",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${className} flex flex-col items-center text-center`}>
      <p className="text-muted-foreground">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A list still loading: three rows' worth of skeleton. */
export function ListLoading({ className = "mt-6" }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div className={`${className} space-y-3`} role="status" aria-label={t("common.loading")}>
      {Array.from({ length: 3 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

/** What a list says when the search matches none of its rows. */
export function ListNoResults({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <p className="py-12 text-center text-sm text-muted-foreground">{children ?? t("common.noResults")}</p>;
}
