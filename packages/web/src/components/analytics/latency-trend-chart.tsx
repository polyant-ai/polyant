// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  Line,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
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
import { useI18n } from "@/lib/i18n/context";
import { PERCENTILE_COLORS } from "./chart-palette";

const chartConfig = {
  p50: { label: "p50", color: PERCENTILE_COLORS.p50 },
  p95: { label: "p95", color: PERCENTILE_COLORS.p95 },
  p99: { label: "p99", color: PERCENTILE_COLORS.p99 },
} satisfies ChartConfig;

interface LatencyTrendChartProps {
  data: LatencyDailyRow[];
}

export function LatencyTrendChart({ data }: LatencyTrendChartProps) {
  const { t, locale } = useI18n();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("analytics.charts.latencyTrend")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => {
                const d = new Date(v);
                return `${d.getDate()}/${d.getMonth() + 1}`;
              }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => `${v}ms`}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(v) => {
                    const d = new Date(v);
                    return d.toLocaleDateString(locale);
                  }}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Line
              dataKey="p50"
              type="monotone"
              stroke={chartConfig.p50.color}
              strokeWidth={2}
              dot={false}
            />
            <Line
              dataKey="p95"
              type="monotone"
              stroke={chartConfig.p95.color}
              strokeWidth={2}
              dot={false}
              strokeDasharray="5 5"
            />
            <Line
              dataKey="p99"
              type="monotone"
              stroke={chartConfig.p99.color}
              strokeWidth={1.5}
              dot={false}
              strokeDasharray="2 2"
            />
          </LineChart>
        </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
