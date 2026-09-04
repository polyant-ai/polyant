// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { Instance } from "@/lib/api";
import { MemoryCard } from "./memory-card";
import { LangsmithCard } from "./langsmith-card";
import { SettingsTab } from "./settings-tab";

/**
 * What the engine carries into a turn, what it keeps after, and what it records
 * about both — the page called "Avanzate".
 *
 * Order matters: the per-turn parameters first (the reason most people open this
 * page), then memory (what survives the turn), then the tracing. It reads as the
 * life of a turn, from what goes in to what is left behind.
 *
 * Three things that were in three different destinations and are one subject:
 * the per-turn parameters lived under the model picker (none of them is a
 * property of which model runs), memory kept moving between the model settings,
 * the agent's identity and the knowledge documents, and LangSmith sat under the
 * agent's name — where "what traces this agent" reads as part of its label.
 *
 * Three independent forms on one page, each with its own dirty state, all served
 * by the header's single Save: `PageActionsProvider` aggregates them and writes
 * only what changed, in sequence.
 */
export function ParamsTab({
  instance,
  onUpdate,
}: {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}) {
  return (
    <div className="space-y-8">
      <SettingsTab instance={instance} onUpdate={onUpdate} section="params" />
      <MemoryCard instance={instance} onUpdate={onUpdate} />
      <LangsmithCard instance={instance} onUpdate={onUpdate} />
    </div>
  );
}
