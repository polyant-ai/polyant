// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyTrendRow, PreviousDailyCostRow } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { dailyValues, dayTick } from "./daily-series";

interface CostTrendChartProps {
  data: DailyTrendRow[];
  previous: PreviousDailyCostRow[];
  days: readonly string[];
}

/**
 * Daily cost, with the previous period drawn beneath it day for day.
 *
 * The KPI above already says how much the total moved; this line says where:
 * a one-day spike and a steady climb give the same "+19%".
 */
export function CostTrendChart({ data, previous, days }: CostTrendChartProps) {
  const { t, locale } = useI18n();
  const fmt = useFormat();

  const chartConfig = {
    cost: { label: t("analytics.chart.cost"), color: "var(--chart-1)" },
    previousCost: { label: t("analytics.chart.previousPeriod"), color: "var(--chart-3)" },
  } satisfies ChartConfig;

  const rows = useMemo(() => {
    const current = dailyValues(data, days, (row) => row.cost);
    const before = new Map(previous.map((row) => [row.dayOffset, row.cost]));
    return days.map((date, i) => ({ date, cost: current[i], previousCost: before.get(i) ?? 0 }));
  }, [data, previous, days]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.costTrend")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[280px] w-full">
          <AreaChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="fillCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-cost)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--color-cost)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayTick} />
            <YAxis
              width="auto"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => fmt.currencyTick(Number(v))}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(v) => formatDate(String(v), locale)}
                  formatter={(value, name) => {
                    const key = name as keyof typeof chartConfig;
                    return (
                      <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: `var(--color-${key})` }}
                          />
                          {chartConfig[key]?.label}
                        </span>
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {fmt.currency(Number(value))}
                        </span>
                      </div>
                    );
                  }}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Line
              dataKey="previousCost"
              type="monotone"
              stroke="var(--color-previousCost)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
            />
            <Area dataKey="cost" type="monotone" fill="url(#fillCost)" stroke="var(--color-cost)" strokeWidth={2} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
