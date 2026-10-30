// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ChannelRow } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { RankedBars } from "./ranked-bars";

interface ChannelDistributionChartProps {
  data: ChannelRow[];
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Conversations per channel, busiest first. */
export function ChannelDistributionChart({ data }: ChannelDistributionChartProps) {
  const { t } = useI18n();
  const fmt = useFormat();

  const rows = useMemo(
    () =>
      [...data]
        .sort((a, b) => b.conversations - a.conversations)
        .map((row) => ({ key: row.channel, label: capitalise(row.channel), value: row.conversations })),
    [data],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.channelDistribution")}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <RankedBars rows={rows} formatValue={fmt.number} />
        )}
      </CardContent>
    </Card>
  );
}
