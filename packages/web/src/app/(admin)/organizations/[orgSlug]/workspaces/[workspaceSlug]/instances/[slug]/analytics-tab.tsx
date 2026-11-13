// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { AnalyticsDashboard, type AnalyticsFetcher } from "@/components/analytics/analytics-dashboard";

interface AnalyticsTabProps {
  slug: string;
}

export function AnalyticsTab({ slug }: AnalyticsTabProps) {
  const fetchData = useCallback<AnalyticsFetcher>(
    (from, to, part) => api.analytics.instance(slug, from, to, part),
    [slug],
  );

  return <AnalyticsDashboard fetchData={fetchData} />;
}
