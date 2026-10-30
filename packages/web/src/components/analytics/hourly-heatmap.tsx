// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HourlyRow } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";

interface HourlyHeatmapProps {
  data: HourlyRow[];
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const HOUR_LABELS = new Set([0, 6, 12, 18]);

/**
 * When people write: one cell per hour of each day of the week, darker where
 * more messages arrived.
 *
 * It used to be a bar per hour summed over every day, so ten in the morning on
 * a Sunday counted the same as on a Monday, and the busy hours of the working
 * week hid inside a single average.
 */
export function HourlyHeatmap({ data }: HourlyHeatmapProps) {
  const { t } = useI18n();
  const fmt = useFormat();
  const weekdays = t("analytics.heatmap.weekdays").split(",");

  const { grid, max } = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const row of data) cells[row.weekday][row.hour] = row.count;
    return { grid: cells, max: Math.max(0, ...data.map((row) => row.count)) };
  }, [data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.hourlyDistribution")}</CardTitle>
      </CardHeader>
      <CardContent>
        {max === 0 ? (
          <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div
              className="grid min-w-[480px] gap-[3px] text-[10px] text-muted-foreground"
              style={{ gridTemplateColumns: "2.5rem repeat(24, minmax(0, 1fr))" }}
            >
              {grid.map((hours, weekday) => (
                <div key={weekday} className="contents">
                  <span className="self-center pr-2">{weekdays[weekday]}</span>
                  {hours.map((count, hour) => (
                    <span
                      key={hour}
                      title={`${weekdays[weekday]} ${String(hour).padStart(2, "0")}:00 · ${fmt.number(count)}`}
                      className="h-5 rounded-[3px] bg-foreground"
                      style={{ opacity: count === 0 ? 0.04 : 0.12 + (count / max) * 0.88 }}
                    />
                  ))}
                </div>
              ))}
              <span />
              {HOURS.map((hour) => (
                <span key={hour} className="pt-1 tabular-nums">
                  {HOUR_LABELS.has(hour) ? `${hour}:00` : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
