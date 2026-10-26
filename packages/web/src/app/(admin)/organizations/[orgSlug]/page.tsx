// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useI18n } from "@/lib/i18n/context";
import { PageHeader } from "@/components/layout/page-header";
import { api } from "@/lib/api";
import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard";
import { FirstStepsCard } from "@/components/onboarding/first-steps-card";

export default function DashboardPage() {
  const { t } = useI18n();

  return (
    <div>
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
      />

      <FirstStepsCard />

      <div className="mt-6">
        <AnalyticsDashboard
          fetchData={api.analytics.global}
          showInstanceComparison
        />
      </div>
    </div>
  );
}
