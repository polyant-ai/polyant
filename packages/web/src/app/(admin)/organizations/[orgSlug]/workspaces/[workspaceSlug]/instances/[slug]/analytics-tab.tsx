// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard";

interface AnalyticsTabProps {
  slug: string;
}

export function AnalyticsTab({ slug }: AnalyticsTabProps) {
  const fetchData = useCallback(
    (from: string, to: string) => api.analytics.instance(slug, from, to),
    [slug],
  );

  return <AnalyticsDashboard fetchData={fetchData} />;
}
