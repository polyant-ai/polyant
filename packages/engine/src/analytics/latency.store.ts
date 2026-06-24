// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { type DateRange, toISO, asRows, instanceFilter } from "../utils/query-helpers.js";
import { buildOrgScopedAgentFilterFragment } from "../authz/scope-filter.js";

// ── Types ────────────────────────────────────────────────────────────

export interface LatencyOverview {
  p50: number;
  p95: number;
  p99: number;
  avgTotal: number;
  avgTtfb: number | null;
  sampleCount: number;
}

export interface LatencyDailyRow {
  date: string;
  p50: number;
  p95: number;
  p99: number;
}

export interface PhaseBreakdownRow {
  date: string;
  contextPrep: number;
  toolBuilding: number;
  llmCall: number;
}

export interface ToolLatencyRow {
  tool: string;
  avgDurationMs: number;
  callCount: number;
  p95: number;
  successRate: number;
}

export interface LatencyData {
  overview: LatencyOverview;
  dailyLatency: LatencyDailyRow[];
  phaseBreakdown: PhaseBreakdownRow[];
  slowestTools: ToolLatencyRow[];
}

// ── Overview (percentiles + averages) ────────────────────────────────

async function getLatencyOverview(
  range: DateRange,
  instanceId?: string,
  orgId?: string,
): Promise<LatencyOverview> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);

  const [row] = asRows<{
    p50: number | null;
    p95: number | null;
    p99: number | null;
    avg_total: number | null;
    avg_ttfb: number | null;
    sample_count: number;
  }>(
    await db.execute(sql`
      SELECT
        percentile_cont(0.50) WITHIN GROUP (ORDER BY total_ms)::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::int AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY total_ms)::int AS p99,
        AVG(total_ms)::float AS avg_total,
        AVG(ttfb_ms)::float AS avg_ttfb,
        COUNT(*)::int AS sample_count
      FROM pipeline_traces
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
    `),
  );

  return {
    p50: row?.p50 ?? 0,
    p95: row?.p95 ?? 0,
    p99: row?.p99 ?? 0,
    avgTotal: row?.avg_total ?? 0,
    avgTtfb: row?.avg_ttfb ?? null,
    sampleCount: row?.sample_count ?? 0,
  };
}

// ── Daily Percentiles ────────────────────────────────────────────────

async function getDailyLatency(
  range: DateRange,
  instanceId?: string,
  orgId?: string,
): Promise<LatencyDailyRow[]> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);

  return asRows<{ date: string; p50: number; p95: number; p99: number }>(
    await db.execute(sql`
      SELECT
        DATE(created_at) AS date,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY total_ms)::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::int AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY total_ms)::int AS p99
      FROM pipeline_traces
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
      GROUP BY DATE(created_at)
      ORDER BY date
    `),
  ).map((r) => ({
    date: String(r.date),
    p50: r.p50 ?? 0,
    p95: r.p95 ?? 0,
    p99: r.p99 ?? 0,
  }));
}

// ── Phase Breakdown (daily averages) ─────────────────────────────────

async function getPhaseBreakdown(
  range: DateRange,
  instanceId?: string,
  orgId?: string,
): Promise<PhaseBreakdownRow[]> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);

  return asRows<{
    date: string;
    avg_context_prep: number;
    avg_tool_building: number;
    avg_llm_call: number;
  }>(
    await db.execute(sql`
      SELECT
        DATE(created_at) AS date,
        COALESCE(AVG(context_prep_ms), 0)::float AS avg_context_prep,
        COALESCE(AVG(tool_building_ms), 0)::float AS avg_tool_building,
        COALESCE(AVG(llm_call_ms), 0)::float AS avg_llm_call
      FROM pipeline_traces
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
      GROUP BY DATE(created_at)
      ORDER BY date
    `),
  ).map((r) => ({
    date: String(r.date),
    contextPrep: r.avg_context_prep ?? 0,
    toolBuilding: r.avg_tool_building ?? 0,
    llmCall: r.avg_llm_call ?? 0,
  }));
}

// ── Slowest Tool Calls ───────────────────────────────────────────────

async function getSlowestTools(
  range: DateRange,
  instanceId?: string,
  orgId?: string,
): Promise<ToolLatencyRow[]> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);

  return asRows<{
    tool: string;
    avg_duration_ms: number;
    call_count: number;
    p95: number;
    success_rate: number;
  }>(
    await db.execute(sql`
      SELECT
        tool_call->>'name' AS tool,
        AVG((tool_call->>'duration_ms')::int)::float AS avg_duration_ms,
        COUNT(*)::int AS call_count,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY (tool_call->>'duration_ms')::int)::int AS p95,
        (SUM(CASE WHEN (tool_call->>'success')::boolean THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0)) AS success_rate
      FROM pipeline_traces
      CROSS JOIN LATERAL jsonb_array_elements(tool_calls) AS tool_call
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
        AND tool_calls IS NOT NULL
        AND jsonb_array_length(tool_calls) > 0
      GROUP BY tool_call->>'name'
      ORDER BY avg_duration_ms DESC
      LIMIT 10
    `),
  ).map((r) => ({
    tool: r.tool,
    avgDurationMs: r.avg_duration_ms ?? 0,
    callCount: r.call_count ?? 0,
    p95: r.p95 ?? 0,
    successRate: r.success_rate ?? 1,
  }));
}

// ── Main Aggregator ──────────────────────────────────────────────────

export async function getLatencyAnalytics(
  range: DateRange,
  instanceId?: string,
  orgId?: string,
): Promise<LatencyData> {
  const [overview, dailyLatency, phaseBreakdown, slowestTools] = await Promise.all([
    getLatencyOverview(range, instanceId, orgId),
    getDailyLatency(range, instanceId, orgId),
    getPhaseBreakdown(range, instanceId, orgId),
    getSlowestTools(range, instanceId, orgId),
  ]);

  return { overview, dailyLatency, phaseBreakdown, slowestTools };
}
