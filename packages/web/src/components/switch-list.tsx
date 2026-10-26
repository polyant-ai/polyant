// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ListControlCell, ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { ListNoResults } from "@/components/list-states";
import { useListView } from "@/components/use-list-view";
import { useI18n } from "@/lib/i18n/context";

export interface SwitchListColumn<T> {
  header: string;
  /** Width class of the column (`w-40`); the name column takes what is left. */
  className?: string;
  /** A date or time: it never wraps. */
  nowrap?: boolean;
  cell: (row: T) => ReactNode;
}

/**
 * A list of things that are on or off: the name (with the line under it), any
 * extra columns, and the Switch column headed "Active" at the end, under a search
 * box. Skills, MCP servers, hooks, webhooks, scheduled tasks, documents.
 *
 * `onToggle` does the write and throws when it fails, and the caller reports the
 * failure (a toast): the switch shows the new position at once and goes back to
 * the stored one when `onToggle` throws. After a write that succeeded the switch
 * keeps the chosen position until the rows say something different from what they
 * said before, so it never flashes the old value while the list is read again.
 *
 * A row can open a detail (`onOpen`); a row for which `disabledReason` answers a
 * text keeps its switch off the table and says why in a tooltip.
 */
export function SwitchList<T>({
  rows,
  rowKey,
  name,
  nameHeader,
  summary,
  badges,
  icon,
  columns,
  searchText,
  sortKey = (row) => name(row),
  isOn,
  onToggle,
  switchLabel,
  disabledReason,
  onOpen,
  openLabel,
  selectedKey,
  searchLabel,
}: {
  rows: readonly T[];
  rowKey: (row: T) => string;
  name: (row: T) => string;
  nameHeader: string;
  summary?: (row: T) => ReactNode;
  badges?: (row: T) => ReactNode;
  icon?: (row: T) => ReactNode;
  /** Columns between the name and the switch, in the order shown. */
  columns?: ReadonlyArray<SwitchListColumn<T>>;
  /** What the search matches, beyond the name and a text summary. */
  searchText?: (row: T) => ReadonlyArray<string | null | undefined>;
  /** What rows are ordered by; `null` keeps the given order. Defaults to the name. */
  sortKey?: ((row: T) => string) | null;
  isOn: (row: T) => boolean;
  onToggle: (row: T, next: boolean) => Promise<unknown>;
  /** The switch's accessible name, naming the row. */
  switchLabel: (row: T) => string;
  disabledReason?: (row: T) => string | null | undefined;
  onOpen?: (row: T) => void;
  /** The accessible name of the name button that opens the row; defaults to the name. */
  openLabel?: (row: T) => string;
  selectedKey?: string | null;
  searchLabel?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  // A switch that was flipped: where it was, where it was put, and whether the write is done.
  const [chosen, setChosen] = useState<Readonly<Record<string, { next: boolean; before: boolean; settled: boolean }>>>({});

  const visible = useListView(
    rows,
    query,
    (row) => {
      const line = summary?.(row);
      return [name(row), typeof line === "string" ? line : undefined, ...(searchText?.(row) ?? [])];
    },
    sortKey,
  );

  const valueOf = (row: T) => chosen[rowKey(row)]?.next ?? isOn(row);

  // Once the rows read again hold something other than what they held at the click, the
  // stored value has arrived and the chosen position is no longer needed.
  const arrived = rows.filter((row) => {
    const entry = chosen[rowKey(row)];
    return entry?.settled && isOn(row) !== entry.before;
  });
  if (arrived.length > 0) {
    const next = { ...chosen };
    for (const row of arrived) delete next[rowKey(row)];
    setChosen(next);
  }

  async function toggle(row: T, next: boolean) {
    const key = rowKey(row);
    setChosen((prev) => ({ ...prev, [key]: { next, before: isOn(row), settled: false } }));
    try {
      await onToggle(row, next);
      setChosen((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], settled: true } } : prev));
    } catch {
      // The caller reports it; the switch goes back to what is stored.
      setChosen((prev) => {
        const rest = { ...prev };
        delete rest[key];
        return rest;
      });
    }
  }

  return (
    <TooltipProvider>
      {/* Its own element, so a parent's `space-y-*` does not add to the table's gap. */}
      <div>
      <ListToolbar value={query} onChange={setQuery} label={searchLabel} className="mt-0" />
      {visible.length === 0 ? (
        <ListNoResults />
      ) : (
        <ListTable>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <ListHead>{nameHeader}</ListHead>
              {columns?.map((column) => (
                <ListHead key={column.header} className={column.className}>
                  {column.header}
                </ListHead>
              ))}
              <ListHead align="end" className="w-28">{t("common.active")}</ListHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => {
              const key = rowKey(row);
              const reason = disabledReason?.(row);
              const open = onOpen ? () => onOpen(row) : undefined;
              const on = valueOf(row);
              return (
                <ListRow key={key} onOpen={open} selected={selectedKey === key} muted={!on}>
                  <ListNameCell
                    name={name(row)}
                    onOpen={open}
                    openLabel={openLabel?.(row)}
                    icon={icon?.(row)}
                    badges={badges?.(row)}
                    summary={summary?.(row)}
                  />
                  {columns?.map((column) => (
                    <TableCell key={column.header} className={column.nowrap ? "whitespace-nowrap" : "whitespace-normal"}>
                      {column.cell(row)}
                    </TableCell>
                  ))}
                  <ListControlCell>
                    {reason ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="inline-flex cursor-help">
                            <Switch checked={on} disabled aria-label={switchLabel(row)} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-72">
                          {reason}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Switch checked={on} onCheckedChange={(next) => void toggle(row, next)} aria-label={switchLabel(row)} />
                    )}
                  </ListControlCell>
                </ListRow>
              );
            })}
          </TableBody>
        </ListTable>
      )}
      </div>
    </TooltipProvider>
  );
}
