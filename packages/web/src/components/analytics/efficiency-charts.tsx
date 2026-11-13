// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { DailyTrendRow, LatencyDailyRow } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { dailyCacheHitRates, dailyCostPerTurn, dayTick } from "./daily-series";

/**
 * One daily ratio as a line over the period. Days without a value are skipped:
 * the line joins the days that have one, and a quiet day draws no fall to zero.
 */
function DailyRatioCard({
  title,
  values,
  days,
  tick,
  format,
  domain,
}: {
  title: string;
  values: readonly (number | null)[];
  days: readonly string[];
  tick: (value: number) => string;
  format: (value: number) => string;
  domain?: [number, number];
}) {
  const { t, locale } = useI18n();
  const chartConfig = { value: { label: title, color: "var(--chart-1)" } } satisfies ChartConfig;
  const rows = useMemo(() => days.map((date, i) => ({ date, value: values[i] })), [days, values]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {values.every((value) => value === null) ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={dayTick} />
              <YAxis domain={domain} width="auto" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => tick(Number(v))} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(v) => formatDate(String(v), locale)}
                    formatter={(value) => (
                      <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: "var(--color-value)" }} />
                          {title}
                        </span>
                        <span className="font-mono font-medium tabular-nums text-foreground">{format(Number(value))}</span>
                      </div>
                    )}
                  />
                }
              />
              <Line dataKey="value" type="monotone" stroke="var(--color-value)" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

/** How much of each day's prompt the provider read from its cache, the daily view of the cache hit tile. */
export function CacheHitRateChart({ data, days }: { data: DailyTrendRow[]; days: readonly string[] }) {
  const { t } = useI18n();
  const values = useMemo(() => dailyCacheHitRates(data, days), [data, days]);
  return <DailyRatioCard title={t("analytics.charts.cacheHitRate")} values={values} days={days} tick={percent} format={percent} domain={[0, 1]} />;
}

/** What one reply cost each day, everything the model was called for that day included. */
export function CostPerTurnChart({
  data,
  latency,
  days,
}: {
  data: DailyTrendRow[];
  latency: LatencyDailyRow[];
  days: readonly string[];
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const values = useMemo(() => dailyCostPerTurn(data, latency, days), [data, latency, days]);
  return (
    <DailyRatioCard
      title={t("analytics.charts.costPerTurn")}
      values={values}
      days={days}
      tick={fmt.currencyTick}
      format={fmt.currency}
    />
  );
}
