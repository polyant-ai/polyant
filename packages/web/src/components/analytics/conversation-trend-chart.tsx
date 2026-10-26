// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyTrendRow } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface ConversationTrendChartProps {
  data: DailyTrendRow[];
}

export function ConversationTrendChart({ data }: ConversationTrendChartProps) {
  const { t } = useI18n();
  const chartConfig = {
    conversations: {
      label: t("analytics.kpi.conversations"),
      color: "var(--chart-1)",
    },
    messages: {
      label: t("analytics.kpi.messages"),
      color: "var(--chart-2)",
    },
  } satisfies ChartConfig;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("analytics.charts.conversationTrend")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[250px] w-full">
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
            <defs>
              <linearGradient id="fillConv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-conversations)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-conversations)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="fillMsg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-messages)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--color-messages)" stopOpacity={0} />
              </linearGradient>
            </defs>
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
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              dataKey="messages"
              type="monotone"
              fill="url(#fillMsg)"
              stroke="var(--color-messages)"
              strokeWidth={2}
            />
            <Area
              dataKey="conversations"
              type="monotone"
              fill="url(#fillConv)"
              stroke="var(--color-conversations)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
