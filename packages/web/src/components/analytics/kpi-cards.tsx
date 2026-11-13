// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { ComponentType } from "react";
import { DollarSign, MessageSquare, Mail, Zap, Database } from "lucide-react";
import type { AnalyticsSummaryResponse } from "@/lib/api";
import { formatLatency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { useFormat } from "@/lib/use-format";
import { dailyValues } from "./daily-series";
import { KpiTileSkeleton } from "./dashboard-skeletons";
import { KpiTile, type KpiTileProps } from "./kpi-tile";

interface KpiCardsProps {
  /** The summary half of the dashboard is enough: the tiles never read the activity. */
  data: AnalyticsSummaryResponse;
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
function responseTimeTile(data: AnalyticsSummaryResponse): Omit<KpiTileProps, "label" | "icon"> {
  const latency = data.latency;
  if (latency && latency.overview.sampleCount > 0) {
    const previous = latency.previousOverview;
    return {
      value: formatLatency(latency.overview.p50),
      trend: previous.sampleCount > 0 ? pctChange(latency.overview.p50, previous.p50) : null,
      previous: previous.sampleCount > 0 ? formatLatency(previous.p50) : undefined,
      // Only the days that had turns: a quiet day has no response time, and a zero there drew a fake drop.
      series: latency.dailyLatency.map((row) => row.p50),
    };
  }
  const { overview } = data;
  return {
    value: formatLatency(overview.avgResponseTime),
    trend: overview.trends.responseTime,
    previous: overview.previousPeriod.avgResponseTime > 0 ? formatLatency(overview.previousPeriod.avgResponseTime) : undefined,
  };
}

/** The five tiles, in order: shared by the row and its placeholder so the two cannot disagree. */
const KPI_TILES = {
  cost: { label: "analytics.kpi.cost", icon: DollarSign },
  conversations: { label: "analytics.kpi.conversations", icon: MessageSquare },
  messages: { label: "analytics.kpi.messages", icon: Mail },
  responseTime: { label: "analytics.kpi.responseTime", icon: Zap },
  cacheHitRate: { label: "analytics.kpi.cacheHitRate", icon: Database },
} as const satisfies Record<string, { label: TranslationKey; icon: ComponentType<{ className?: string }> }>;

const KPI_ROW = "grid gap-4 *:min-w-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5";

/** The KPI row before the overview arrives: each tile's label and icon, the figures still to come. */
export function KpiCardsSkeleton() {
  const { t } = useI18n();
  return (
    <div className={KPI_ROW}>
      {Object.values(KPI_TILES).map((tile) => (
        <KpiTileSkeleton key={tile.label} label={t(tile.label)} icon={tile.icon} />
      ))}
    </div>
  );
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
      label: t(KPI_TILES.cost.label),
      value: fmt.currency(overview.totalCost),
      trend: overview.trends.cost,
      previous: fmt.currency(previous.totalCost),
      series: dailyValues(dailyTrend, days, (row) => row.cost),
      icon: KPI_TILES.cost.icon,
    },
    {
      label: t(KPI_TILES.conversations.label),
      value: formatCount(overview.totalConversations),
      trend: overview.trends.conversations,
      previous: formatCount(previous.totalConversations),
      series: dailyValues(dailyTrend, days, (row) => row.conversations),
      icon: KPI_TILES.conversations.icon,
    },
    {
      label: t(KPI_TILES.messages.label),
      value: formatCount(overview.totalMessages),
      trend: overview.trends.messages,
      previous: formatCount(previous.totalMessages),
      series: dailyValues(dailyTrend, days, (row) => row.messages),
      icon: KPI_TILES.messages.icon,
    },
    {
      label: t(KPI_TILES.responseTime.label),
      ...responseTimeTile(data),
      lowerIsBetter: true,
      icon: KPI_TILES.responseTime.icon,
    },
    {
      label: t(KPI_TILES.cacheHitRate.label),
      value: `${Math.round(cacheRate * 100)}%`,
      // A rate moves in points: 40% to 44% is "+4 pt", where "+10%" would read as a ten-point jump.
      trend: previous.promptTokens > 0 ? (cacheRate - previousCacheRate) * 100 : null,
      trendUnit: "pt",
      // Only the days that sent a prompt, for the same reason.
      series: dailyTrend.filter((row) => row.promptTokens > 0).map((row) => rate(row.cachedInputTokens, row.promptTokens)),
      icon: KPI_TILES.cacheHitRate.icon,
    },
  ];

  return (
    <div className={KPI_ROW} data-tour="dash-tiles">
      {cards.map((card) => (
        <KpiTile key={card.label} {...card} />
      ))}
    </div>
  );
}
