// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { MemoryView } from "@/components/memory/memory-view";
import { useI18n } from "@/lib/i18n/context";

/** The workspace-wide list. The list itself is shared with the agent's Attività. */
export default function MemoryPage() {
  const { t } = useI18n();

  return (
    <div>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("memory.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("memory.subtitle")}</p>
      </div>
      <div className="mt-6">
        <MemoryView />
      </div>
    </div>
  );
}
