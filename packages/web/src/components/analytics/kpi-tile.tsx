// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { ComponentType } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/lib/i18n/context";
import { Sparkline } from "./sparkline";

/** Above this the previous period was close to empty, and the exact figure says nothing. */
const TREND_CAP = 999;

export interface KpiTileProps {
  label: string;
  value: string;
  icon?: ComponentType<{ className?: string }>;
  /** The change from the previous period; `null` when there is nothing to compare against. */
  trend?: number | null;
  /** `%` for a relative change, `pt` for the change of a rate in percentage points. */
  trendUnit?: "%" | "pt";
  lowerIsBetter?: boolean;
  /** The previous period's figure, shown where a percentage cannot say how much it moved. */
  previous?: string;
  /** One value per day of the period. */
  series?: readonly number[];
}

/**
 * How the figure moved against the previous period.
 *
 * The sign and the arrow say which way it went; the colour alone says whether
 * that is good, so a metric where less is better passes `lowerIsBetter`
 * instead of a negated value. When the previous period was empty or nearly so,
 * a percentage like ">+999%" says nothing: the previous figure is shown
 * instead, in a neutral pill, so the reader sees the two numbers.
 */
function Comparison({
  trend,
  trendUnit = "%",
  lowerIsBetter = false,
  previous,
}: Pick<KpiTileProps, "trend" | "trendUnit" | "lowerIsBetter" | "previous">) {
  const { t } = useI18n();
  const usable = trend !== null && trend !== undefined && Number.isFinite(trend);
  const capped = usable && trendUnit === "%" && Math.abs(trend) > TREND_CAP;

  if (!usable || capped) {
    if (previous === undefined) return null;
    return (
      <span
        title={t("analytics.kpi.trendHint")}
        className="inline-flex items-center whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums"
      >
        {t("analytics.kpi.previousValue", { value: previous })}
      </span>
    );
  }

  const rounded = trendUnit === "pt" ? Math.round(trend) : Math.round(trend * 10) / 10;
  if (rounded === 0) {
    return <span className="text-xs text-muted-foreground">{t("analytics.kpi.unchanged")}</span>;
  }
  const isUp = rounded > 0;
  const isGood = isUp !== lowerIsBetter;
  const label = trendUnit === "pt" ? `${isUp ? "+" : ""}${rounded} pt` : `${isUp ? "+" : ""}${rounded.toFixed(1)}%`;
  return (
    <>
      <span
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
          isGood ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
        }`}
      >
        {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{t("analytics.kpi.vsPrevious")}</span>
    </>
  );
}

/** One figure of a KPI row: label, value, how it moved, and its daily shape along the bottom edge. */
export function KpiTile({ label, value, icon: Icon, series, ...comparison }: KpiTileProps) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-col gap-1.5 px-5 pt-5 pb-4">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-muted-foreground" title={label}>
            {label}
          </p>
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        </div>
        <p className="truncate text-2xl font-semibold tracking-tight tabular-nums" title={value}>
          {value}
        </p>
        <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
          <Comparison {...comparison} />
        </div>
      </div>
      {series && <Sparkline values={series} className="mt-auto block h-10 w-full" />}
    </Card>
  );
}
