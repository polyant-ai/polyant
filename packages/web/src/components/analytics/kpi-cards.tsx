// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { DollarSign, MessageSquare, Mail, Zap, Database } from "lucide-react";
import type { AnalyticsResponse } from "@/lib/api";
import { formatLatency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { dailyValues } from "./daily-series";
import { KpiTile, type KpiTileProps } from "./kpi-tile";

interface KpiCardsProps {
  data: AnalyticsResponse;
  /** Every day of the period, so each sparkline has one point per day. */
  days: readonly string[];
}

function formatCount(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

function pctChange(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/**
 * The response time a person waits for a turn: the median of the pipeline
 * traces, the same measure the response-time chart draws, so the tile and the
 * chart below it can be read together. Without traces in the period it falls
 * back to the average model call, with no line to draw.
 */
function responseTimeTile(data: AnalyticsResponse, days: readonly string[]): Omit<KpiTileProps, "label" | "icon"> {
  const latency = data.latency;
  if (latency && latency.overview.sampleCount > 0) {
    const previous = latency.previousOverview;
    return {
      value: formatLatency(latency.overview.p50),
      trend: previous.sampleCount > 0 ? pctChange(latency.overview.p50, previous.p50) : null,
      previous: previous.sampleCount > 0 ? formatLatency(previous.p50) : undefined,
      series: dailyValues(latency.dailyLatency, days, (row) => row.p50),
    };
  }
  const { overview } = data;
  return {
    value: formatLatency(overview.avgResponseTime),
    trend: overview.trends.responseTime,
    previous: overview.previousPeriod.avgResponseTime > 0 ? formatLatency(overview.previousPeriod.avgResponseTime) : undefined,
  };
}

export function KpiCards({ data, days }: KpiCardsProps) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { overview, dailyTrend } = data;
  const previous = overview.previousPeriod;

  const cacheRate = rate(overview.cachedInputTokens, overview.promptTokens);
  const previousCacheRate = rate(previous.cachedInputTokens, previous.promptTokens);

  const cards: KpiTileProps[] = [
    {
      label: t("analytics.kpi.cost"),
      value: fmt.currency(overview.totalCost),
      trend: overview.trends.cost,
      previous: fmt.currency(previous.totalCost),
      series: dailyValues(dailyTrend, days, (row) => row.cost),
      icon: DollarSign,
    },
    {
      label: t("analytics.kpi.conversations"),
      value: formatCount(overview.totalConversations),
      trend: overview.trends.conversations,
      previous: formatCount(previous.totalConversations),
      series: dailyValues(dailyTrend, days, (row) => row.conversations),
      icon: MessageSquare,
    },
    {
      label: t("analytics.kpi.messages"),
      value: formatCount(overview.totalMessages),
      trend: overview.trends.messages,
      previous: formatCount(previous.totalMessages),
      series: dailyValues(dailyTrend, days, (row) => row.messages),
      icon: Mail,
    },
    {
      label: t("analytics.kpi.responseTime"),
      ...responseTimeTile(data, days),
      lowerIsBetter: true,
      icon: Zap,
    },
    {
      label: t("analytics.kpi.cacheHitRate"),
      value: `${Math.round(cacheRate * 100)}%`,
      // A rate moves in points: 40% to 44% is "+4 pt", where "+10%" would read as a ten-point jump.
      trend: previous.promptTokens > 0 ? (cacheRate - previousCacheRate) * 100 : null,
      trendUnit: "pt",
      series: dailyValues(dailyTrend, days, (row) => rate(row.cachedInputTokens, row.promptTokens)),
      icon: Database,
    },
  ];

  return (
    <div className="grid gap-4 *:min-w-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" data-tour="dash-tiles">
      {cards.map((card) => (
        <KpiTile key={card.label} {...card} />
      ))}
    </div>
  );
}
