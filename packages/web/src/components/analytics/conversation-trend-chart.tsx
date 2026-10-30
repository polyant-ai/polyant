// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Area, ComposedChart, CartesianGrid, Line, XAxis, YAxis } from "recharts";
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
import { formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { dailyValues, dayTick } from "./daily-series";

interface ConversationTrendChartProps {
  data: DailyTrendRow[];
  days: readonly string[];
}

/**
 * Conversations per day, and how long they were.
 *
 * Messages used to share the conversations' axis, and at seven messages a
 * conversation they flattened the conversation line against the floor. The
 * second series is now messages per conversation on an axis of its own: it
 * reads as conversation length, which is what the message count was standing
 * in for.
 */
export function ConversationTrendChart({ data, days }: ConversationTrendChartProps) {
  const { t, locale } = useI18n();

  const chartConfig = {
    conversations: { label: t("analytics.kpi.conversations"), color: "var(--chart-1)" },
    perConversation: { label: t("analytics.chart.messagesPerConversation"), color: "var(--chart-3)" },
  } satisfies ChartConfig;

  const rows = useMemo(() => {
    const conversations = dailyValues(data, days, (row) => row.conversations);
    const messages = dailyValues(data, days, (row) => row.messages);
    return days.map((date, i) => ({
      date,
      conversations: conversations[i],
      // No conversation that day: no length to draw, rather than a zero.
      perConversation: conversations[i] > 0 ? Math.round((messages[i] / conversations[i]) * 10) / 10 : null,
    }));
  }, [data, days]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.conversationTrend")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[260px] w-full">
          <ComposedChart data={rows} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="fillConv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-conversations)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--color-conversations)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayTick} />
            <YAxis yAxisId="count" width="auto" tickLine={false} axisLine={false} tickMargin={8} allowDecimals={false} />
            <YAxis yAxisId="length" orientation="right" width="auto" tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => formatDate(String(v), locale)} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              yAxisId="count"
              dataKey="conversations"
              type="monotone"
              fill="url(#fillConv)"
              stroke="var(--color-conversations)"
              strokeWidth={2}
            />
            <Line
              yAxisId="length"
              dataKey="perConversation"
              type="monotone"
              stroke="var(--color-perConversation)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
