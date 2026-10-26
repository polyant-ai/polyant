// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { HourlyRow } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
interface HourlyHeatmapProps {
  data: HourlyRow[];
}

export function HourlyHeatmap({ data }: HourlyHeatmapProps) {
  const { t } = useI18n();
  const chartConfig = {
    count: {
      label: t("analytics.kpi.messages"),
      color: "var(--chart-1)",
    },
  } satisfies ChartConfig;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("analytics.charts.hourlyDistribution")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[250px] w-full">
          <BarChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="hour"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => `${v}:00`}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_label, payload) => {
                    const hour = payload?.[0]?.payload?.hour ?? 0;
                    return `${String(hour).padStart(2, "0")}:00 - ${String(hour).padStart(2, "0")}:59`;
                  }}
                />
              }
            />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
