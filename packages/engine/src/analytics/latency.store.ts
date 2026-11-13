// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { analyticsDb } from "../database/client.js";
import { type DateRange, toISO, asRows, instanceFilter, previousRange } from "../utils/query-helpers.js";
import { buildOrgScopedAgentFilterFragment, type TenantScope } from "../authz/scope-filter.js";
import { toModelToolName } from "../utils/model-tool-wire.js";

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
  /**
   * The day's turns: one `pipeline_traces` row is one turn (the pipeline and
   * the direct turns each record one per reply; replay passes add up into it;
   * auto-tasks record none). The panel divides the day's cost by it.
   */
  turns: number;
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
  /** The same figures for the window just before, so the panel can show how the response time moved. */
  previousOverview: LatencyOverview;
  dailyLatency: LatencyDailyRow[];
  phaseBreakdown: PhaseBreakdownRow[];
  slowestTools: ToolLatencyRow[];
  /**
   * Timings of the most called tools, named as the model calls them
   * (`plugin__tool`) so they join `toolUsage`, which reports its counts under
   * that name. The traces store the canonical name (`plugin:tool`), and
   * `slowestTools` keeps it.
   */
  toolTimings: ToolLatencyRow[];
}

// ── Overview (percentiles + averages) ────────────────────────────────

interface LatencyRow {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg_total: number | null;
  avg_ttfb: number | null;
  sample_count: number;
}

function toLatencyOverview(row: LatencyRow | undefined): LatencyOverview {
  return {
    p50: row?.p50 ?? 0,
    p95: row?.p95 ?? 0,
    p99: row?.p99 ?? 0,
    avgTotal: row?.avg_total ?? 0,
    avgTtfb: row?.avg_ttfb ?? null,
    sampleCount: row?.sample_count ?? 0,
  };
}

/**
 * The window's percentiles and averages, overall and per day, with the daily
 * phase averages, from ONE scan of `pipeline_traces`: the overview and the daily
 * series group the same rows, so separate queries read the window twice.
 * `GROUPING(DATE(created_at))` is 1 on the overall row and 0 on each day's.
 */
async function readCurrentLatency(
  scope: TenantScope,
  range: DateRange,
  instanceId?: string,
): Promise<{ overview: LatencyOverview; dailyLatency: LatencyDailyRow[]; phaseBreakdown: PhaseBreakdownRow[] }> {
  const instFilter = instanceFilter(instanceId);
  const tenant = buildOrgScopedAgentFilterFragment(scope);

  const rows = asRows<LatencyRow & {
    grouping_set: number;
    date: string | null;
    avg_context_prep: number;
    avg_tool_building: number;
    avg_llm_call: number;
  }>(
    await analyticsDb.execute(sql`
      SELECT
        GROUPING(DATE(created_at)) AS grouping_set,
        DATE(created_at) AS date,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY total_ms)::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::int AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY total_ms)::int AS p99,
        AVG(total_ms)::float AS avg_total,
        AVG(ttfb_ms)::float AS avg_ttfb,
        COUNT(*)::int AS sample_count,
        COALESCE(AVG(context_prep_ms), 0)::float AS avg_context_prep,
        COALESCE(AVG(tool_building_ms), 0)::float AS avg_tool_building,
        COALESCE(AVG(llm_call_ms), 0)::float AS avg_llm_call
      FROM pipeline_traces
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${tenant}
      GROUP BY GROUPING SETS ((), (DATE(created_at)))
    `),
  );

  const days = rows.filter((r) => r.grouping_set === 0).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    overview: toLatencyOverview(rows.find((r) => r.grouping_set === 1)),
    dailyLatency: days.map((r) => ({
      date: String(r.date),
      p50: r.p50 ?? 0,
      p95: r.p95 ?? 0,
      p99: r.p99 ?? 0,
      turns: r.sample_count ?? 0,
    })),
    phaseBreakdown: days.map((r) => ({
      date: String(r.date),
      contextPrep: r.avg_context_prep ?? 0,
      toolBuilding: r.avg_tool_building ?? 0,
      llmCall: r.avg_llm_call ?? 0,
    })),
  };
}

/**
 * The window before, for the response time's change. Half-open, `[from, to)`:
 * its end is the current window's start, and a trace at that instant belongs to
 * the current window only.
 */
async function readPreviousLatency(
  scope: TenantScope,
  range: DateRange,
  instanceId?: string,
): Promise<LatencyOverview> {
  const instFilter = instanceFilter(instanceId);
  const tenant = buildOrgScopedAgentFilterFragment(scope);
  const { from, to } = previousRange(range);

  const [row] = asRows<LatencyRow>(
    await analyticsDb.execute(sql`
      SELECT
        percentile_cont(0.50) WITHIN GROUP (ORDER BY total_ms)::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms)::int AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY total_ms)::int AS p99,
        AVG(total_ms)::float AS avg_total,
        AVG(ttfb_ms)::float AS avg_ttfb,
        COUNT(*)::int AS sample_count
      FROM pipeline_traces
      WHERE created_at >= ${toISO(from)} AND created_at < ${toISO(to)}
        ${instFilter} ${tenant}
    `),
  );
  return toLatencyOverview(row);
}

// ── Tool timings ─────────────────────────────────────────────────────

/**
 * Every tool's timings in the window, from one scan; the slowest and the most
 * called are cut from the same rows. Ordered by name so that ties keep one order.
 */
async function readToolTimings(
  scope: TenantScope,
  range: DateRange,
  instanceId: string | undefined,
): Promise<ToolLatencyRow[]> {
  const instFilter = instanceFilter(instanceId);
  const tenant = buildOrgScopedAgentFilterFragment(scope);

  return asRows<{
    tool: string;
    avg_duration_ms: number;
    call_count: number;
    p95: number;
    success_rate: number;
  }>(
    await analyticsDb.execute(sql`
      SELECT
        tool_call->>'name' AS tool,
        AVG((tool_call->>'duration_ms')::int)::float AS avg_duration_ms,
        COUNT(*)::int AS call_count,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY (tool_call->>'duration_ms')::int)::int AS p95,
        (SUM(CASE WHEN (tool_call->>'success')::boolean THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0)) AS success_rate
      FROM pipeline_traces
      CROSS JOIN LATERAL jsonb_array_elements(tool_calls) AS tool_call
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${tenant}
        AND tool_calls IS NOT NULL
        AND jsonb_array_length(tool_calls) > 0
      GROUP BY tool_call->>'name'
      ORDER BY tool_call->>'name'
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

/** The response-time figures, from the traces' own columns. */
export type LatencySummary = Omit<LatencyData, "slowestTools" | "toolTimings">;
/** The per-tool timings, which unnest every trace's `tool_calls` and so cost more. */
export type LatencyActivity = Pick<LatencyData, "slowestTools" | "toolTimings">;

export async function getLatencySummary(
  scope: TenantScope,
  range: DateRange,
  instanceId?: string,
): Promise<LatencySummary> {
  const [{ overview, dailyLatency, phaseBreakdown }, previousOverview] = await Promise.all([
    readCurrentLatency(scope, range, instanceId),
    readPreviousLatency(scope, range, instanceId),
  ]);
  return { overview, previousOverview, dailyLatency, phaseBreakdown };
}

export async function getLatencyActivity(
  scope: TenantScope,
  range: DateRange,
  instanceId?: string,
): Promise<LatencyActivity> {
  const tools = await readToolTimings(scope, range, instanceId);
  const slowestTools = [...tools].sort((a, b) => b.avgDurationMs - a.avgDurationMs).slice(0, 10);
  const toolTimings = [...tools]
    .sort((a, b) => b.callCount - a.callCount)
    .slice(0, 20)
    .map((row) => ({ ...row, tool: toModelToolName(row.tool) }));
  return { slowestTools, toolTimings };
}

export async function getLatencyAnalytics(
  scope: TenantScope,
  range: DateRange,
  instanceId?: string,
): Promise<LatencyData> {
  const [summary, activity] = await Promise.all([
    getLatencySummary(scope, range, instanceId),
    getLatencyActivity(scope, range, instanceId),
  ]);
  return { ...summary, ...activity };
}
