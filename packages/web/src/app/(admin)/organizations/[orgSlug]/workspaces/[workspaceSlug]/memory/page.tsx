// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemoryView } from "@/components/memory/memory-view";
import { PageHeader } from "@/components/layout/page-header";
import { useI18n } from "@/lib/i18n/context";

/** The workspace-wide list. The list itself is shared with the agent's Attività. */
export default function MemoryPage() {
  const { t } = useI18n();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div>
      <PageHeader
        title={t("memory.title")}
        subtitle={t("memory.subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t("memory.addMemory")}
          </Button>
        }
      />
      <div className="mt-6">
        <MemoryView createOpen={createOpen} onCreateOpenChange={setCreateOpen} />
      </div>
    </div>
  );
}
