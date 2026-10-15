// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ComponentType, ReactNode } from "react";

/**
 * The placeholder for a surface with nothing to show: an icon in a muted circle,
 * a title, an explanation and, where one exists, the action that fixes it.
 * Permission, licence and capability notices and an empty list are all this
 * shape, so they share it rather than each inlining the markup.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "mt-16",
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${className} flex flex-col items-center text-center`}>
      <div className="rounded-full bg-muted p-4">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="mt-4 text-lg font-medium">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
