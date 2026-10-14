// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { ReactNode } from "react";
import { Table, TableCell, TableHead, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The one shape of a "list of things" page — connections, plugins, skills,
 * members, workspaces. Every such page drew its own: different cell padding,
 * margins, link styles and click targets, so two pages showing the same kind
 * of thing looked like two products. These four pieces are that shape, and
 * `ui-conventions.guardrail.test.ts` stops a page from re-deriving it.
 *
 * - The table lines up with the page's text (`flush`) and has fixed columns.
 * - A row that has a detail opens it from anywhere on the row; the name is
 *   also a real button, so the keyboard reaches it.
 * - Controls in a row (a switch, a menu) never open the row.
 */
export function ListTable({ className, children }: { className?: string; children: ReactNode }) {
  return <Table flush className={cn("mt-4 table-fixed", className)}>{children}</Table>;
}

/** A column heading of a list; `align="end"` for a control column. */
export function ListHead({ className, align, children }: { className?: string; align?: "end"; children?: ReactNode }) {
  return <TableHead className={cn(align === "end" && "text-right", className)}>{children}</TableHead>;
}

/**
 * One row. With `onOpen`, the whole row opens its detail; `selected` while that
 * detail is open. Two states every list draws the same way: `muted` for a row
 * that is switched off or about to be removed, `accent` for one about to be added.
 */
export function ListRow({ onOpen, selected, muted, accent, children }: {
  onOpen?: () => void;
  selected?: boolean;
  muted?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className={cn(onOpen && "cursor-pointer", muted && "opacity-60", accent && "shadow-[inset_3px_0_0_var(--accent)]")}
      onClick={onOpen}
    >
      {children}
    </TableRow>
  );
}

/**
 * The row's identity: optional icon, the name (a button when the row opens),
 * badges beside it, and one muted line under it.
 */
export function ListNameCell({
  name,
  onOpen,
  openLabel,
  icon,
  badges,
  summary,
}: {
  name: string;
  onOpen?: () => void;
  /** Accessible name of the open button; defaults to the name. */
  openLabel?: string;
  icon?: ReactNode;
  badges?: ReactNode;
  summary?: ReactNode;
}) {
  return (
    <TableCell className="whitespace-normal">
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {onOpen ? (
              <button
                type="button"
                aria-label={openLabel}
                className="max-w-full text-left font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
              >
                {name}
              </button>
            ) : (
              <span className="font-medium">{name}</span>
            )}
            {badges}
          </div>
          {summary && <div className="mt-0.5 text-sm text-muted-foreground">{summary}</div>}
        </div>
      </div>
    </TableCell>
  );
}

/** A cell holding controls (a switch, actions): clicking in it never opens the row. */
export function ListControlCell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <TableCell className={cn("text-right", className)} onClick={(event) => event.stopPropagation()}>
      {children}
    </TableCell>
  );
}
