// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TenantScope } from "../authz/scope-filter.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import { TtlCache } from "../utils/ttl-cache.js";
import type { DateRange } from "../utils/query-helpers.js";
import {
  getAnalyticsActivity,
  getAnalyticsSummary,
  type AnalyticsActivity,
  type AnalyticsData,
  type AnalyticsSummary,
} from "./analytics.store.js";
import {
  getLatencyActivity,
  getLatencySummary,
  type LatencyActivity,
  type LatencyData,
  type LatencySummary,
} from "./latency.store.js";

/**
 * The two halves of the analytics dashboard, which the panel asks for
 * separately: `summary` is what the KPIs and the trend charts draw and reads
 * through indexes; `activity` is the hourly grid and the per-tool figures, which
 * unnest message and trace payloads and grow with the volume. Without a part the
 * response holds both, as it always has, for the API's other readers.
 */
export const DASHBOARD_PARTS = ["summary", "activity"] as const;
export type DashboardPart = (typeof DASHBOARD_PARTS)[number];

export type DashboardSummary = AnalyticsSummary & { latency: LatencySummary };
export type DashboardActivity = AnalyticsActivity & { latency: LatencyActivity };
export type DashboardData = AnalyticsData & { latency: LatencyData };

export interface DashboardRequest {
  /** Resolved by the caller from the route and the membership, as every tenant read. */
  scope: TenantScope;
  range: DateRange;
  instanceId?: InstanceSlug;
  includeInstanceComparison: boolean;
}

/**
 * How long one computed half is shared. The dashboard is the landing page, so
 * everyone in a workspace opens it, and on a large tenant each computation costs
 * seconds of the database's CPU while its figures move on a scale of hours. The
 * readers of the same scope and period within two minutes share one
 * computation. Per process: with N replicas it is computed at most N times.
 *
 * The key is the RESOLVED scope, never the caller: two people who reach the same
 * workspaces read the same rows, and two who do not get different keys.
 */
const SHARED_FOR_MS = 120_000;
const MAX_SHARED_RESULTS = 500;
const shared = new TtlCache<string, Promise<unknown>>({ maxSize: MAX_SHARED_RESULTS, ttlMs: SHARED_FOR_MS });

function scopeKey(scope: TenantScope): unknown {
  if ("allTenants" in scope) return ["all"];
  if ("organizationId" in scope) {
    return "workspaceIds" in scope
      ? ["org-ws", scope.organizationId, [...scope.workspaceIds].sort()]
      : ["org", scope.organizationId];
  }
  if ("workspaceId" in scope) return ["ws", scope.workspaceId];
  return ["ws-set", [...scope.workspaceIds].sort()];
}

function cacheKey(part: DashboardPart, req: DashboardRequest): string {
  return JSON.stringify([
    part,
    scopeKey(req.scope),
    req.instanceId ?? null,
    req.range.from.getTime(),
    req.range.to.getTime(),
    part === "summary" ? req.includeInstanceComparison : null,
  ]);
}

/**
 * The promise is stored before it settles, so a request arriving while the first
 * is still reading joins it. A failed read leaves at once: the next request reads
 * again instead of receiving the error for the whole window.
 */
function sharedRead<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = shared.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const read = compute();
  shared.set(key, read);
  read.catch(() => {
    if (shared.get(key) === read) shared.delete(key);
  });
  return read;
}

function readSummary(req: DashboardRequest): Promise<DashboardSummary> {
  return sharedRead(cacheKey("summary", req), async () => {
    const [analytics, latency] = await Promise.all([
      getAnalyticsSummary(req.scope, req.range, req.instanceId, req.includeInstanceComparison),
      getLatencySummary(req.scope, req.range, req.instanceId),
    ]);
    return { ...analytics, latency };
  });
}

function readActivity(req: DashboardRequest): Promise<DashboardActivity> {
  return sharedRead(cacheKey("activity", req), async () => {
    const [analytics, latency] = await Promise.all([
      getAnalyticsActivity(req.scope, req.range, req.instanceId),
      getLatencyActivity(req.scope, req.range, req.instanceId),
    ]);
    return { ...analytics, latency };
  });
}

/** The response for a part: one half, or the whole when no part is asked for. */
export type DashboardFor<P extends DashboardPart | undefined> = P extends "summary"
  ? DashboardSummary
  : P extends "activity"
    ? DashboardActivity
    : DashboardData;

export async function readDashboard<P extends DashboardPart | undefined = undefined>(
  req: DashboardRequest,
  part?: P,
): Promise<DashboardFor<P>> {
  if (part === "summary") return (await readSummary(req)) as DashboardFor<P>;
  if (part === "activity") return (await readActivity(req)) as DashboardFor<P>;
  const [summary, activity] = await Promise.all([readSummary(req), readActivity(req)]);
  const whole: DashboardData = { ...summary, ...activity, latency: { ...summary.latency, ...activity.latency } };
  return whole as DashboardFor<P>;
}

/** For tests: forget every shared result. */
export function clearDashboardCache(): void {
  shared.clear();
}
