// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useState } from "react";
import { subDays, format } from "date-fns";
import { toast } from "sonner";
import type { AnalyticsPart, AnalyticsPartResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { DateRangePicker, type DateRange } from "./date-range-picker";
import { ChartCardSkeleton } from "./dashboard-skeletons";
import { KpiCards, KpiCardsSkeleton } from "./kpi-cards";
import { CostTrendChart } from "./cost-trend-chart";
import { ConversationTrendChart } from "./conversation-trend-chart";
import { HourlyHeatmap } from "./hourly-heatmap";
import { ModelDistributionChart } from "./model-distribution-chart";
import { ChannelDistributionChart } from "./channel-distribution-chart";
import { InstanceComparisonTable } from "./instance-comparison-table";
import { LatencyTrendChart } from "./latency-trend-chart";
import { ToolTable } from "./tool-table";
import { eachDay } from "./daily-series";

/** Reads one half of the dashboard for a period: see `AnalyticsPart`. */
export type AnalyticsFetcher = <P extends AnalyticsPart>(
  from: string,
  to: string,
  part: P,
) => Promise<AnalyticsPartResponse<P>>;

interface AnalyticsDashboardProps {
  fetchData: AnalyticsFetcher;
  showInstanceComparison?: boolean;
}

const toISO = (d: Date) => format(d, "yyyy-MM-dd");

/**
 * One half of the dashboard for the period on screen. A change of period empties
 * it at once, so a card never shows the previous period's figures under the new
 * dates, and an answer that arrives after the period moved on is dropped.
 */
function useDashboardPart<P extends AnalyticsPart>(
  fetchData: AnalyticsFetcher,
  range: DateRange,
  part: P,
): AnalyticsPartResponse<P> | null {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<{ range: DateRange; data: AnalyticsPartResponse<P> } | null>(null);

  useEffect(() => {
    let current = true;
    fetchData(range.from, range.to, part).then(
      (data) => {
        if (current) setLoaded({ range, data });
      },
      () => {
        if (current) toast.error(t("analytics.loadFailed"));
      },
    );
    return () => {
      current = false;
    };
  }, [fetchData, range, part, t]);

  return loaded?.range === range ? loaded.data : null;
}

export function AnalyticsDashboard({
  fetchData,
  showInstanceComparison = false,
}: AnalyticsDashboardProps) {
  const { t } = useI18n();
  const [range, setRange] = useState<DateRange>(() => {
    const now = new Date();
    return { from: toISO(subDays(now, 30)), to: toISO(now) };
  });
  // Two reads for one period: the summary draws everything on top as soon as it
  // lands; the activity (hourly grid, tool table) reads every message of the
  // window and fills its two cards when it arrives.
  const data = useDashboardPart(fetchData, range, "summary");
  const activity = useDashboardPart(fetchData, range, "activity");
  const days = useMemo(() => eachDay(range.from, range.to), [range]);

  // The layout is drawn from the first frame: each card shows its own outline
  // until the half of the answer it charts arrives, so nothing moves when it does.
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* Summary first, then one row per question: what it cost, how much it was used, how well it answered, when. */}
      {data ? <KpiCards data={data} days={days} /> : <KpiCardsSkeleton />}

      <div className="grid gap-4 *:min-w-0 xl:grid-cols-3">
        <div className="xl:col-span-2 *:h-full">
          {data ? (
            <CostTrendChart data={data.dailyTrend} previous={data.previousDailyCost} days={days} />
          ) : (
            <ChartCardSkeleton title={t("analytics.charts.costTrend")} shape={{ kind: "line", height: 280 }} />
          )}
        </div>
        {data ? (
          <ModelDistributionChart data={data.modelDistribution} tiers={data.tierDistribution} />
        ) : (
          <ChartCardSkeleton title={t("analytics.charts.modelDistribution")} shape={{ kind: "bars" }} />
        )}
      </div>

      <div className="grid gap-4 *:min-w-0 xl:grid-cols-3">
        <div className="xl:col-span-2 *:h-full">
          {data ? (
            <ConversationTrendChart data={data.dailyTrend} days={days} />
          ) : (
            <ChartCardSkeleton title={t("analytics.charts.conversationTrend")} shape={{ kind: "line", height: 260 }} />
          )}
        </div>
        {data ? (
          <ChannelDistributionChart data={data.channelDistribution} />
        ) : (
          <ChartCardSkeleton title={t("analytics.charts.channelDistribution")} shape={{ kind: "bars" }} />
        )}
      </div>

      <div className="grid gap-4 *:min-w-0 xl:grid-cols-2">
        {data ? (
          <LatencyTrendChart data={data.latency?.dailyLatency ?? []} days={days} />
        ) : (
          <ChartCardSkeleton title={t("analytics.charts.latencyTrend")} shape={{ kind: "line", height: 260 }} />
        )}
        {activity ? (
          <ToolTable usage={activity.toolUsage} latency={activity.latency?.toolTimings ?? []} />
        ) : (
          <ChartCardSkeleton title={t("analytics.charts.tools")} shape={{ kind: "table", rows: 5 }} />
        )}
      </div>

      {activity ? (
        <HourlyHeatmap data={activity.hourlyDistribution} />
      ) : (
        <ChartCardSkeleton title={t("analytics.charts.hourlyDistribution")} shape={{ kind: "heatmap" }} />
      )}

      {showInstanceComparison &&
        (data ? (
          <InstanceComparisonTable data={data.instanceComparison ?? []} />
        ) : (
          <ChartCardSkeleton title={t("analytics.charts.instanceComparison")} shape={{ kind: "table", rows: 3 }} />
        ))}
    </div>
  );
}
