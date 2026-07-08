// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { DollarSign, MessageSquare, Mail, Zap, Database, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { AnalyticsOverview } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

interface KpiCardsProps {
  data: AnalyticsOverview;
}

function formatCost(value: number) {
  return value < 1
    ? `$${value.toFixed(4)}`
    : `$${value.toFixed(2)}`;
}

function formatNumber(value: number) {
  return value >= 1000
    ? `${(value / 1000).toFixed(1)}k`
    : String(Math.round(value));
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function TrendBadge({ value }: { value: number }) {
  if (value === 0) return null;
  const isPositive = value > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        isPositive ? "text-success" : "text-destructive"
      }`}
    >
      {isPositive ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {isPositive ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

export function KpiCards({ data }: KpiCardsProps) {
  const { t } = useI18n();

  const cards = [
    {
      label: t("analytics.kpi.cost"),
      value: formatCost(data.totalCost),
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
      trend: -data.trends.responseTime, // lower is better
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">
                {card.label}
              </p>
              <card.icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <p className="text-2xl font-semibold tracking-tight">
                {card.value}
              </p>
              <TrendBadge value={card.trend} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
