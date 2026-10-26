// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemoryView } from "@/components/memory/memory-view";
import { useI18n } from "@/lib/i18n/context";
import { SectionActions } from "./section-actions";

/**
 * What this agent has remembered: the workspace list with the agent fixed, so the
 * "pick an agent" step it opens with elsewhere is already done.
 */
export function AgentMemoriesTab({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <SectionActions>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 size-4" />
          {t("memory.addMemory")}
        </Button>
      </SectionActions>
      <MemoryView lockedInstanceId={slug} createOpen={createOpen} onCreateOpenChange={setCreateOpen} />
    </>
  );
}
