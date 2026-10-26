// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MonitorSource } from "./monitor.types.js";
import { toolCallSource } from "./sources/tool-call.source.js";
import { hookExecutionSource } from "./sources/hook-execution.source.js";
import { webhookSource } from "./sources/webhook.source.js";
import { scheduledRunSource } from "./sources/scheduled-run.source.js";

/**
 * The sources the Monitor reads, in the order their chips show. A build that records more
 * kinds of event calls {@link registerMonitorSource} at boot; registering a `type` twice
 * replaces the earlier source, so an overlay can also widen one it inherits.
 */
const sources = new Map<string, MonitorSource>(
  [toolCallSource, hookExecutionSource, webhookSource, scheduledRunSource].map((s) => [s.type, s]),
);

export function registerMonitorSource(source: MonitorSource): void {
  sources.set(source.type, source);
}

export function listMonitorSources(): MonitorSource[] {
  return [...sources.values()];
}

export function findMonitorSource(type: string): MonitorSource | undefined {
  return sources.get(type);
}
