// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MonitorOutcome } from "@/lib/api-types";

/** The outcomes offered as a filter. `blocked` is a policy refusing a call, for a build that records it. */
export const MONITOR_OUTCOMES_UI = ["ok", "error", "blocked", "running"] as const satisfies readonly MonitorOutcome[];
