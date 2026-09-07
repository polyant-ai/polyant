// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useI18n } from "@/lib/i18n/context";
import { TriggersRunsTab } from "./triggers-runs-tab";

/**
 * What FIRED — the records, one page, under Attività.
 *
 * They lived beside the configuration they record, under Automazioni. So "did
 * anything happen?" started at the same destination you go to in order to CHANGE
 * a rule — the opposite intent.
 *
 * ONE heading per block, named for what it records — Webhook, Programmati. The
 * first pass had a block called "Esecuzioni" containing two sub-blocks that
 * repeated those names, and a table titled "Log esecuzioni" inside a section
 * titled "Log": three levels of heading saying the same word.
 *
 * Enterprise adds two more blocks here — the governance events and the retention
 * purges — for the same reason and in the same shape.
 */
export function LogsTab({ slug }: { slug: string }) {
  const { t } = useI18n();

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h3 className="text-xl font-semibold">{t("instances.section.logsWebhookTitle")}</h3>
        <TriggersRunsTab slug={slug} block="webhook" />
      </section>

      <section className="space-y-4">
        <h3 className="text-xl font-semibold">{t("instances.section.logsScheduledTitle")}</h3>
        <TriggersRunsTab slug={slug} block="scheduled" />
      </section>
    </div>
  );
}
