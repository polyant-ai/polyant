// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { MemoryView } from "@/components/memory/memory-view";
import { PageHeader } from "@/components/layout/page-header";
import { useI18n } from "@/lib/i18n/context";

/** The workspace-wide list. The list itself is shared with the agent's Attività. */
export default function MemoryPage() {
  const { t } = useI18n();

  return (
    <div>
      <PageHeader title={t("memory.title")} subtitle={t("memory.subtitle")} />
      <div className="mt-6">
        <MemoryView />
      </div>
    </div>
  );
}
