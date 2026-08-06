// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useI18n } from "@/lib/i18n/context";
import { api } from "@/lib/api";
import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard";

export default function DashboardPage() {
  const { t } = useI18n();

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">
        {t("dashboard.title")}
      </h1>
      <p className="mt-2 text-muted-foreground">{t("dashboard.subtitle")}</p>

      <div className="mt-6">
        <AnalyticsDashboard
          fetchData={api.analytics.global}
          showInstanceComparison
        />
      </div>
    </div>
  );
}
