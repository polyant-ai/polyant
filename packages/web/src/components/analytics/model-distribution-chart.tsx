// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Pie, PieChart, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { ModelRow } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"];

/** How many models are named. The rest become one slice. */
export const MAX_NAMED_MODELS = 2;

export interface ModelSlice {
  name: string;
  value: number;
}

/**
 * The two busiest models, plus everything else as one slice.
 *
 * A deployment accumulates models — this one had eighteen — and a pie with
 * eighteen legend entries is not a chart: it was 1599px of legend in a 430px card,
 * which overflowed onto the page. Three slices answer the question the card is
 * asking ("what is this agent mostly running on?"); the long tail answers nothing
 * a pie can show.
 *
 * Folding starts only when there are at least two models to fold: "Altri (1)" is
 * strictly worse than naming that one model, so a three-model deployment sees all
 * three.
 *
 * Sorted here rather than trusted from the API: the slice order decides which
 * models get named, so it must not depend on a store's `ORDER BY` staying put.
 */
export function topModelsWithRest(data: ModelRow[], othersLabel: (count: number) => string): ModelSlice[] {
  const sorted = [...data].sort((a, b) => b.calls - a.calls);
  if (sorted.length <= MAX_NAMED_MODELS + 1) {
    return sorted.map((r) => ({ name: r.model, value: r.calls }));
  }

  const named = sorted.slice(0, MAX_NAMED_MODELS);
  const rest = sorted.slice(MAX_NAMED_MODELS);
  return [
    ...named.map((r) => ({ name: r.model, value: r.calls })),
    // The count is in the label because a large unnamed slice otherwise says
    // nothing at all about what it contains.
    { name: othersLabel(rest.length), value: rest.reduce((sum, r) => sum + r.calls, 0) },
  ];
}

interface ModelDistributionChartProps {
  data: ModelRow[];
}

export function ModelDistributionChart({ data }: ModelDistributionChartProps) {
  const { t } = useI18n();

  const slices = useMemo(
    () => topModelsWithRest(data, (count) => t("analytics.charts.otherModels", { count })),
    [data, t],
  );

  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    slices.forEach((slice, i) => {
      cfg[slice.name] = { label: slice.name, color: COLORS[i % COLORS.length] };
    });
    return cfg;
  }, [slices]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("analytics.charts.modelDistribution")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="mx-auto h-[250px] w-full">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                strokeWidth={2}
              >
                {slices.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="name" />} />
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
