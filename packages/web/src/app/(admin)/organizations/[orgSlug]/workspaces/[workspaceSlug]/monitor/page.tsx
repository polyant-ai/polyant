// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Suspense, useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { MonitorView } from "@/components/monitor/monitor-view";
import { NO_FILTERS, type MonitorFilters } from "@/components/monitor/use-monitor-feed";
import { MONITOR_OUTCOMES_UI } from "@/lib/monitor/outcomes";
import { useI18n } from "@/lib/i18n/context";

const KEYS = ["group", "type", "agent", "outcome", "q"] as const;

function filtersFrom(params: URLSearchParams): MonitorFilters {
  const outcome = params.get("outcome") ?? "";
  return {
    group: params.get("group") ?? "",
    type: params.get("type") ?? "",
    agent: params.get("agent") ?? "",
    outcome: (MONITOR_OUTCOMES_UI as readonly string[]).includes(outcome) ? (outcome as MonitorFilters["outcome"]) : "",
    q: params.get("q") ?? "",
  };
}

function MonitorPageContent() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = useMemo(() => filtersFrom(new URLSearchParams(params.toString())), [params]);

  // The filters live in the URL, so a link (the old Activity and Tool Traces routes
  // among them) opens the Monitor already narrowed and a reload keeps the view.
  const onChange = useCallback(
    (next: MonitorFilters) => {
      const query = new URLSearchParams();
      for (const key of KEYS) if (next[key] && next[key] !== NO_FILTERS[key]) query.set(key, next[key]);
      const text = query.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("monitor.title")} subtitle={t("monitor.subtitle")} />
      <MonitorView value={value} onChange={onChange} />
    </div>
  );
}

export default function MonitorPage() {
  return (
    <Suspense fallback={null}>
      <MonitorPageContent />
    </Suspense>
  );
}
