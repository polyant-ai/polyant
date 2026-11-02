// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ModelRow, TierRow } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { RankedBars } from "./ranked-bars";

/** `ai_logs.call_type` of titles, summaries and checks nobody is waiting for. */
const SERVICE_CALL_TYPE = "service";

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
export function topModelsWithRest(
  data: ModelRow[],
  othersLabel: (count: number) => string,
  serviceLabel?: string,
): ModelSlice[] {
  return namedSlices(data, othersLabel, serviceLabel);
}

/**
 * Service calls (titles, summaries, checks) run on a fast-tier model the person
 * never chose, so naming that model would present it as a choice. They fold into
 * one slice under `serviceLabel`; the other calls are summed per model, because
 * the same model appears once per call type.
 */
function namedSlices(
  data: ModelRow[],
  othersLabel: (count: number) => string,
  serviceLabel?: string,
): ModelSlice[] {
  const service = serviceLabel === undefined ? [] : data.filter((r) => r.callType === SERVICE_CALL_TYPE);
  const chosen = serviceLabel === undefined ? data : data.filter((r) => r.callType !== SERVICE_CALL_TYPE);
  const byModel = new Map<string, number>();
  for (const r of chosen) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.calls);
  const merged = topWithRest(
    [...byModel].map(([model, calls]) => ({ model, calls })),
    othersLabel,
  );
  const serviceCalls = service.reduce((sum, r) => sum + r.calls, 0);
  return serviceCalls > 0 ? [...merged, { name: serviceLabel as string, value: serviceCalls }] : merged;
}

function topWithRest(
  data: { model: string; calls: number }[],
  othersLabel: (count: number) => string,
): ModelSlice[] {
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
  tiers: TierRow[];
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Which models answered, and below it the tiers they were asked for.
 *
 * The tier breakdown used to be a card of its own, a donut of "fast /
 * standard / heavy" that read as nothing without the models beside it.
 */
export function ModelDistributionChart({ data, tiers }: ModelDistributionChartProps) {
  const { t } = useI18n();
  const fmt = useFormat();

  const modelRows = useMemo(() => {
    const named = new Set(data.map((row) => row.model));
    return topModelsWithRest(
      data,
      (count) => t("analytics.charts.otherModels", { count }),
      t("analytics.charts.serviceCalls"),
    ).map((slice) => ({ key: slice.name, label: slice.name, value: slice.value, muted: !named.has(slice.name) }));
  }, [data, t]);

  const tierRows = useMemo(
    () =>
      [...tiers]
        .sort((a, b) => b.calls - a.calls)
        .map((row) => ({ key: row.tier, label: capitalise(row.tier), value: row.calls })),
    [tiers],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("analytics.charts.modelDistribution")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {modelRows.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            {t("analytics.noData")}
          </div>
        ) : (
          <RankedBars rows={modelRows} formatValue={fmt.number} />
        )}
        {tierRows.length > 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("analytics.charts.tierDistribution")}
            </p>
            <RankedBars rows={tierRows} formatValue={fmt.number} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
