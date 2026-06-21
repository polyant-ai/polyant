// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InstanceComparisonRow } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface InstanceComparisonTableProps {
  data: InstanceComparisonRow[];
}

function formatCost(value: number) {
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function InstanceComparisonTable({ data }: InstanceComparisonTableProps) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("analytics.charts.instanceComparison")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[100px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("analytics.table.instance")}</TableHead>
              <TableHead className="text-right">
                {t("analytics.table.conversations")}
              </TableHead>
              <TableHead className="text-right">
                {t("analytics.table.tokens")}
              </TableHead>
              <TableHead className="text-right">
                {t("analytics.table.cost")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.agentId}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="text-right">{row.conversations}</TableCell>
                <TableCell className="text-right">
                  {formatTokens(row.tokens)}
                </TableCell>
                <TableCell className="text-right">
                  {formatCost(row.cost)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        )}
      </CardContent>
    </Card>
  );
}
