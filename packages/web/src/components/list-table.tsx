// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { statusVariant, type StatusTone } from "@/components/status-badge";
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
export function ListRow({ onOpen, href, selected, muted, accent, children }: {
  onOpen?: () => void;
  /** A destination with a page of its own: a click on the row goes there (the name is the real link). */
  href?: string;
  selected?: boolean;
  muted?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  if (href !== undefined) {
    return (
      <HrefRow href={href} selected={selected} muted={muted} accent={accent}>
        {children}
      </HrefRow>
    );
  }
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

/** A row that navigates; split out so only rows with an `href` need the router. */
function HrefRow({ href, selected, muted, accent, children }: {
  href: string;
  selected?: boolean;
  muted?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className={cn("cursor-pointer", muted && "opacity-60", accent && "shadow-[inset_3px_0_0_var(--accent)]")}
      onClick={() => router.push(href)}
    >
      {children}
    </TableRow>
  );
}

/**
 * The row's identity: optional icon, the name (a button when the row opens),
 * badges beside it, and the secondary information under it, at most two lines
 * (the full text is in `title` when it is a string).
 */
export function ListNameCell({
  name,
  onOpen,
  href,
  openLabel,
  icon,
  badges,
  summary,
}: {
  name: string;
  onOpen?: () => void;
  /** The name is a real link to this address (middle-click, open in new tab); for a row that is a destination. */
  href?: string;
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
            {href !== undefined ? (
              <Link
                href={href}
                aria-label={openLabel}
                className="max-w-full text-left font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={(event) => event.stopPropagation()}
              >
                {name}
              </Link>
            ) : onOpen ? (
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
          {summary && (
            <div
              className="mt-0.5 line-clamp-2 text-sm text-muted-foreground"
              title={typeof summary === "string" ? summary : undefined}
            >
              {summary}
            </div>
          )}
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

/** A cell holding one status (with `tone`) or one neutral label (a category, a type, a channel), as the default-size badge. */
export function ListBadgeCell({
  tone,
  className,
  children,
}: {
  /** A status value (see `StatusBadge`); without it the cell holds a neutral label, a `secondary` badge. */
  tone?: StatusTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TableCell className={className}>
      <Badge variant={tone ? statusVariant(tone) : "secondary"}>{children}</Badge>
    </TableCell>
  );
}

/**
 * A cell of secondary information (a date, a count) in muted text that never wraps. `align="end"`
 * for the last column, under a `ListHead align="end"`.
 */
export function ListMetaCell({
  align,
  className,
  children,
}: {
  align?: "end";
  className?: string;
  /** Empty (null, undefined or "") reads as the em dash, in every list. */
  children?: ReactNode;
}) {
  return (
    <TableCell className={cn("whitespace-nowrap text-muted-foreground", align === "end" && "text-right", className)}>
      {children === null || children === undefined || children === "" ? EMPTY_CELL : children}
    </TableCell>
  );
}

/** What a cell shows when it has no value. */
export const EMPTY_CELL = "—";
