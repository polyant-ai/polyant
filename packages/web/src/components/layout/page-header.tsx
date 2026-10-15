// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";

/**
 * The title block at the top of a page: h1, optional subtitle, optional actions
 * on the right. Render it once above a body that switches between loading and
 * content, so the heading does not jump when data arrives.
 */
export function PageHeader({
  title,
  subtitle,
  subtitleClassName = "mt-1 text-muted-foreground",
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Overrides the subtitle's spacing and colour, for a page that sets it differently. */
  subtitleClassName?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className={subtitleClassName}>{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
