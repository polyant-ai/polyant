// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { LatencyDailyRow } from "@/lib/api";
import { formatDate, formatLatency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { dayKey, dayTick } from "./daily-series";

interface LatencyTrendChartProps {
  data: LatencyDailyRow[];
  days: readonly string[];
}

/** An axis tick in seconds: "20 s", where milliseconds printed "20000ms" and the first digit was cut off. */
const secondsTick = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * How long a turn took, per day: the typical turn (median) and the slow one
 * (95th percentile), the same measure as the response-time tile above.
 *
 * The 99th percentile is left out: over a few hundred turns a day it is one
 * or two turns, and its line swung the axis without saying anything.
 */
export function LatencyTrendChart({ data, days }: LatencyTrendChartProps) {
  const { t, locale } = useI18n();

  const chartConfig = {
    p50: { label: t("analytics.latency.typical"), color: "var(--chart-1)" },
    p95: { label: t("analytics.latency.slow"), color: "var(--chart-3)" },
  } satisfies ChartConfig;

  const rows = useMemo(() => {
    const byDay = new Map(data.map((row) => [dayKey(row.date), row]));
    // A day with no turn has no response time: a gap in the line, not a zero.
    return days.map((date) => ({ date, p50: byDay.get(date)?.p50 ?? null, p95: byDay.get(date)?.p95 ?? null }));
  }, [data, days]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.latencyTrend")}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayTick} />
              <YAxis width="auto" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => secondsTick(Number(v))} />
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
                            {formatLatency(Number(value))}
                          </span>
                        </div>
                      );
                    }}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Line dataKey="p50" type="monotone" stroke="var(--color-p50)" strokeWidth={2} dot={false} />
              <Line
                dataKey="p95"
                type="monotone"
                stroke="var(--color-p95)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
