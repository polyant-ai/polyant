// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { MonitorView } from "@/components/monitor/monitor-view";
import { NO_FILTERS, type MonitorFilters } from "@/components/monitor/use-monitor-feed";

/**
 * What this agent did: the Monitor, pinned to the agent. The page and this tab show
 * the same component; only the agent filter differs, so there is one implementation
 * of the timeline to keep right.
 */
export function LogsTab({ slug }: { slug: string }) {
  const [filters, setFilters] = useState<MonitorFilters>(NO_FILTERS);
  return <MonitorView value={filters} onChange={setFilters} lockedAgent={slug} />;
}
