// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { DollarSign, MessageSquare, Mail, Zap, Database, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { AnalyticsOverview } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";

interface KpiCardsProps {
  data: AnalyticsOverview;
}

function formatNumber(value: number) {
  return value >= 1000
    ? `${(value / 1000).toFixed(1)}k`
    : String(Math.round(value));
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

/** Above this the previous period was close to empty, and the exact figure says nothing. */
const TREND_CAP = 999;

/**
 * The period-over-period change, or nothing at all when it is exactly zero (a
 * "+0.0%" badge is noise where an absent one reads as "unchanged") or `null`
 * (the previous period was zero, so there is nothing to compare against).
 *
 * The sign and the arrow always show which way the number moved; the colour
 * alone says whether that is good. A metric where less is better passes
 * `lowerIsBetter` instead of a negated value, which used to print a response
 * time that had grown 436% as "-435.8%".
 */
function TrendBadge({ value, lowerIsBetter = false }: { value: number | null; lowerIsBetter?: boolean }) {
  const { t } = useI18n();
  if (value === null || value === 0 || !Number.isFinite(value)) return null;
  const isUp = value > 0;
  const isGood = isUp !== lowerIsBetter;
  const capped = Math.abs(value) > TREND_CAP;
  const label = capped ? `${isUp ? ">+" : "<-"}${TREND_CAP}%` : `${isUp ? "+" : ""}${value.toFixed(1)}%`;
  return (
    <span
      title={t(capped ? "analytics.kpi.trendCappedHint" : "analytics.kpi.trendHint")}
      className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs font-medium ${
        isGood ? "text-success" : "text-destructive"
      }`}
    >
      {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {label}
    </span>
  );
}

export function KpiCards({ data }: KpiCardsProps) {
  const { t } = useI18n();
  const fmt = useFormat();

  const cards = [
    {
      label: t("analytics.kpi.cost"),
      value: fmt.currency(data.totalCost),
      trend: data.trends.cost,
      icon: DollarSign,
    },
    {
      label: t("analytics.kpi.conversations"),
      value: formatNumber(data.totalConversations),
      trend: data.trends.conversations,
      icon: MessageSquare,
    },
    {
      label: t("analytics.kpi.messages"),
      value: formatNumber(data.totalMessages),
      trend: data.trends.messages,
      icon: Mail,
    },
    {
      label: t("analytics.kpi.responseTime"),
      value: formatDuration(data.avgResponseTime),
      trend: data.trends.responseTime,
      lowerIsBetter: true,
      icon: Zap,
    },
    {
      label: t("analytics.kpi.cacheHitRate"),
      value: formatPercent(
        data.promptTokens > 0 ? data.cachedInputTokens / data.promptTokens : 0,
      ),
      trend: 0,
      icon: Database,
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" data-tour="dash-tiles">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent >
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-sm font-medium text-muted-foreground">
                {card.label}
              </p>
              <card.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
            {/* Wraps so a long value and its trend stack in a narrow tile instead of spilling out of it. */}
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <p className="min-w-0 break-all text-2xl font-semibold tracking-tight">
                {card.value}
              </p>
              <TrendBadge value={card.trend} lowerIsBetter={card.lowerIsBetter} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
