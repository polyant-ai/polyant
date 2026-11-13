// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyChannelRow } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { channelLabel } from "./channels";
import { dayKey, dayTick } from "./daily-series";

/** The busiest channels keep a colour each, in this order; the rest share one grey. */
const CHANNEL_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
const OTHER_COLOR = "var(--chart-5)";
const OTHER = "other";

/**
 * The series of the stack: the channels of the period busiest first, each under
 * a key of its own (a channel name is not a safe CSS variable name), and beyond
 * the palette one "other channels" series. Exported for its test.
 */
export function channelSeries(rows: readonly DailyChannelRow[]): {
  channels: { channel: string; key: string; color: string }[];
  hasOther: boolean;
} {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.channel, (totals.get(row.channel) ?? 0) + row.conversations);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([channel]) => channel);
  return {
    channels: ranked.slice(0, CHANNEL_COLORS.length).map((channel, i) => ({ channel, key: `c${i}`, color: CHANNEL_COLORS[i] })),
    hasOther: ranked.length > CHANNEL_COLORS.length,
  };
}

/**
 * Conversations per day, stacked by the channel they came through: the stack's
 * height is the day's total, and its layers say where that total came from.
 */
export function ChannelTrendChart({ data, days }: { data: DailyChannelRow[]; days: readonly string[] }) {
  const { t, locale } = useI18n();

  const { chartConfig, keys, rows } = useMemo(() => {
    const { channels, hasOther } = channelSeries(data);
    const config: ChartConfig = {};
    for (const { channel, key, color } of channels) config[key] = { label: channelLabel(channel), color };
    if (hasOther) config[OTHER] = { label: t("analytics.chart.otherChannels"), color: OTHER_COLOR };
    const seriesKeys = Object.keys(config);

    const keyOf = new Map(channels.map(({ channel, key }) => [channel, key]));
    const byDay = new Map(days.map((day) => [day, Object.fromEntries(seriesKeys.map((key) => [key, 0]))]));
    for (const row of data) {
      const counts = byDay.get(dayKey(row.date));
      if (counts) counts[keyOf.get(row.channel) ?? OTHER] += row.conversations;
    }
    return {
      chartConfig: config,
      keys: seriesKeys,
      rows: days.map((date) => ({ date, ...byDay.get(date) })),
    };
  }, [data, days, t]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.channelTrend")}</CardTitle>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayTick} />
              <YAxis width="auto" tickLine={false} axisLine={false} tickMargin={8} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => formatDate(String(v), locale)} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {keys.map((key) => (
                <Bar key={key} dataKey={key} stackId="channels" fill={`var(--color-${key})`} />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
