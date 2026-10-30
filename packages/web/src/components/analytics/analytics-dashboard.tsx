// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { subDays, format } from "date-fns";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { DateRangePicker, type DateRange } from "./date-range-picker";
import { KpiCards } from "./kpi-cards";
import { CostTrendChart } from "./cost-trend-chart";
import { ConversationTrendChart } from "./conversation-trend-chart";
import { HourlyHeatmap } from "./hourly-heatmap";
import { ModelDistributionChart } from "./model-distribution-chart";
import { ChannelDistributionChart } from "./channel-distribution-chart";
import { InstanceComparisonTable } from "./instance-comparison-table";
import { LatencyTrendChart } from "./latency-trend-chart";
import { ToolTable } from "./tool-table";
import { eachDay } from "./daily-series";

interface AnalyticsDashboardProps {
  fetchData: (from: string, to: string) => Promise<AnalyticsResponse>;
  showInstanceComparison?: boolean;
}

const toISO = (d: Date) => format(d, "yyyy-MM-dd");

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[140px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-[340px] rounded-xl lg:col-span-2" />
        <Skeleton className="h-[340px] rounded-xl" />
      </div>
    </div>
  );
}

export function AnalyticsDashboard({
  fetchData,
  showInstanceComparison = false,
}: AnalyticsDashboardProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [range, setRange] = useState<DateRange>(() => {
    const now = new Date();
    return { from: toISO(subDays(now, 30)), to: toISO(now) };
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchData(range.from, range.to);
      setData(result);
    } catch {
      toast.error(t("analytics.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [fetchData, range, t]);

  useEffect(() => {
    load();
  }, [load]);

  const days = useMemo(() => eachDay(range.from, range.to), [range]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {loading || !data ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* Summary first, then one row per question: what it cost, how much it was used, how well it answered, when. */}
          <KpiCards data={data} days={days} />

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2 *:h-full">
              <CostTrendChart data={data.dailyTrend} previous={data.previousDailyCost} days={days} />
            </div>
            <ModelDistributionChart data={data.modelDistribution} tiers={data.tierDistribution} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2 *:h-full">
              <ConversationTrendChart data={data.dailyTrend} days={days} />
            </div>
            <ChannelDistributionChart data={data.channelDistribution} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <LatencyTrendChart data={data.latency?.dailyLatency ?? []} days={days} />
            <ToolTable usage={data.toolUsage} latency={data.latency?.slowestTools ?? []} />
          </div>

          <HourlyHeatmap data={data.hourlyDistribution} />

          {showInstanceComparison && (
            <InstanceComparisonTable data={data.instanceComparison ?? []} />
          )}
        </>
      )}
    </div>
  );
}
