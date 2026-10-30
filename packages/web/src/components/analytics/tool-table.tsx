// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ToolLatencyRow, ToolRow } from "@/lib/api";
import { formatLatency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";

/** Below this share of successful calls a tool's success rate is drawn as a problem. */
const SUCCESS_WARNING = 0.95;
const MAX_ROWS = 10;

interface ToolTableRow {
  tool: string;
  calls: number;
  successRate: number | null;
  p95: number | null;
}

/**
 * How often each tool ran and how well, in one place.
 *
 * The counts come from the conversation steps and the timings from the
 * pipeline traces, which the API returns as two lists; they used to be two
 * cards, a coloured bar chart and a latency chart, and a slow tool could not
 * be read against how often it ran. A tool the traces have no timing for
 * shows a dash rather than a guess.
 */
export function mergeToolRows(usage: readonly ToolRow[], latency: readonly ToolLatencyRow[]): ToolTableRow[] {
  const timing = new Map(latency.map((row) => [row.tool, row]));
  const rows: ToolTableRow[] = usage.map((row) => {
    const t = timing.get(row.tool);
    return { tool: row.tool, calls: row.count, successRate: t?.successRate ?? null, p95: t?.p95 ?? null };
  });
  const counted = new Set(usage.map((row) => row.tool));
  for (const t of latency) {
    if (!counted.has(t.tool)) rows.push({ tool: t.tool, calls: t.callCount, successRate: t.successRate, p95: t.p95 });
  }
  return rows.sort((a, b) => b.calls - a.calls).slice(0, MAX_ROWS);
}

export function ToolTable({ usage, latency }: { usage: readonly ToolRow[]; latency: readonly ToolLatencyRow[] }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const rows = useMemo(() => mergeToolRows(usage, latency), [usage, latency]);
  const maxCalls = rows[0]?.calls ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.tools")}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("analytics.table.tool")}</TableHead>
                <TableHead className="w-[35%]">{t("analytics.table.calls")}</TableHead>
                <TableHead className="text-right">{t("analytics.table.success")}</TableHead>
                <TableHead className="text-right">{t("analytics.table.p95")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.tool}>
                  <TableCell className="max-w-[12rem] truncate font-medium" title={row.tool}>
                    {row.tool}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-foreground"
                          style={{ width: `${maxCalls > 0 ? (row.calls / maxCalls) * 100 : 0}%` }}
                        />
                      </span>
                      <span className="w-12 text-right tabular-nums">{fmt.number(row.calls)}</span>
                    </div>
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${
                      row.successRate !== null && row.successRate < SUCCESS_WARNING ? "font-medium text-destructive" : ""
                    }`}
                  >
                    {row.successRate === null ? "—" : `${(row.successRate * 100).toFixed(1)}%`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.p95 === null ? "—" : formatLatency(row.p95)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
