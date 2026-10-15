// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";

/**
 * Previous / next with "page X of Y", for a list paged by one-based page number.
 * Without `summary` it renders nothing for a single page and the pair is
 * centered; with one, the line reads on the left and the buttons sit on the
 * right (a table that wants to say how many rows there are), even for one page.
 */
export function Pager({
  page,
  totalPages,
  onPage,
  summary,
  className,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  summary?: string;
  className?: string;
}) {
  const { t } = useI18n();
  if (totalPages <= 1 && summary === undefined) return null;
  if (summary !== undefined) {
    return (
      <div className={`flex items-center justify-between ${className ?? ""}`}>
        <p className="text-sm text-muted-foreground">{summary}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            {t("common.previous")}
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
            {t("common.next")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={`mt-4 flex items-center justify-center gap-4 ${className ?? ""}`}>
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
