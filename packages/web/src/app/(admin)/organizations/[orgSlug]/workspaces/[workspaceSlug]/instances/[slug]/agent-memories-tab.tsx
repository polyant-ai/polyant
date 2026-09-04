// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { MemoryView } from "@/components/memory/memory-view";

/**
 * What this agent has remembered: the workspace list with the agent fixed, so the
 * "pick an agent" step it opens with elsewhere is already done.
 */
export function AgentMemoriesTab({ slug }: { slug: string }) {
  return <MemoryView lockedInstanceId={slug} />;
}
