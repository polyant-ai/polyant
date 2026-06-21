// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n/context";
import { TriggersWebhooksTab } from "./triggers-webhooks-tab";
import { TriggersScheduledTab } from "./triggers-scheduled-tab";
import { TriggersRunsTab } from "./triggers-runs-tab";

export function TriggersTab({ slug }: { slug: string }) {
  const { t } = useI18n();

  return (
    <Tabs defaultValue="webhooks">
      <TabsList variant="line">
        <TabsTrigger value="webhooks">{t("triggers.webhooks")}</TabsTrigger>
        <TabsTrigger value="scheduled">{t("triggers.scheduled")}</TabsTrigger>
        <TabsTrigger value="runs">{t("triggers.runs")}</TabsTrigger>
      </TabsList>
      <TabsContent value="webhooks" className="mt-6">
        <TriggersWebhooksTab slug={slug} />
      </TabsContent>
      <TabsContent value="scheduled" className="mt-6">
        <TriggersScheduledTab slug={slug} />
      </TabsContent>
      <TabsContent value="runs" className="mt-6">
        <TriggersRunsTab slug={slug} />
      </TabsContent>
    </Tabs>
  );
}
