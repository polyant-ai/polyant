// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";

/** Previous / next with "page X of Y", for a list paged by one-based page number. Renders nothing for a single page. */
export function Pager({
  page,
  totalPages,
  onPage,
  className,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  className?: string;
}) {
  const { t } = useI18n();
  if (totalPages <= 1) return null;
  return (
    <div className={`flex items-center justify-between ${className ?? ""}`}>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t("common.previous")}
      </Button>
      <span className="text-sm text-muted-foreground">
        {page} / {totalPages}
      </span>
      <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        {t("common.next")}
      </Button>
    </div>
  );
}
