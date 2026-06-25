// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { type DateRange, toISO, asRows, instanceFilter } from "../utils/query-helpers.js";
import { asAgentSlug, type AgentSlug } from "../instances/identifiers.js";
import { buildOrgScopedAgentFilterFragment } from "../authz/scope-filter.js";

export type { DateRange };

// ── Types ──────────────────────────────────────────────────────────

export interface AuditLogRow {
  id: string;
  agentId: AgentSlug;
  conversationId: string | null;
  toolName: string;
  action: string;
  details: Record<string, unknown>;
  success: boolean;
  error: string | null;
  durationMs: number | null;
  output: string | null;
  createdAt: string;
}

export interface AuditLogListResult {
  items: AuditLogRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuditStatsResult {
  totalEntries: number;
  errorCount: number;
  errorRate: number;
  byTool: Array<{ toolName: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
}

// ── List (paginated + filtered) ───────────────────────────────────

export async function listAuditLogs(opts: {
  agentId?: AgentSlug;
  toolName?: string;
  action?: string;
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
  orgId?: string;
}): Promise<AuditLogListResult> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const instFilt = instanceFilter(opts.agentId);
  // Cross-org gate: aggregate audit lists stay scoped to the caller-org agents;
  // a foreign-org agentId param yields zero rows.
  const orgFilt = buildOrgScopedAgentFilterFragment(opts.orgId);
  const toolFilt = opts.toolName ? sql`AND tool_name = ${opts.toolName}` : sql``;
  const actionFilt = opts.action ? sql`AND action = ${opts.action}` : sql``;
  const searchFilt = opts.search
    ? sql`AND (action ILIKE ${"%" + opts.search + "%"} OR error ILIKE ${"%" + opts.search + "%"} OR details::text ILIKE ${"%" + opts.search + "%"})`
    : sql``;
  const fromFilt = opts.from ? sql`AND created_at >= ${toISO(opts.from)}` : sql``;
  const toFilt = opts.to ? sql`AND created_at <= ${toISO(opts.to)}` : sql``;

  const where = sql`WHERE 1=1 ${instFilt} ${orgFilt} ${toolFilt} ${actionFilt} ${searchFilt} ${fromFilt} ${toFilt}`;

  const [countResult, itemsResult] = await Promise.all([
    db.execute(sql`SELECT COUNT(*)::int AS total FROM tool_audit_logs ${where}`),
    db.execute(sql`
      SELECT id, agent_id, conversation_id, tool_name, action, details, success, error, duration_ms, output, created_at
      FROM tool_audit_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  ]);

  const total = asRows<{ total: number }>(countResult)[0]?.total ?? 0;
  const items = asRows<{
    id: string;
    agent_id: string;
    conversation_id: string | null;
    tool_name: string;
    action: string;
    details: Record<string, unknown>;
    success: boolean;
    error: string | null;
    duration_ms: number | null;
    output: string | null;
    created_at: string;
  }>(itemsResult).map((r) => ({
    id: r.id,
    agentId: asAgentSlug(r.agent_id),
    conversationId: r.conversation_id,
    toolName: r.tool_name,
    action: r.action,
    details: r.details,
    success: r.success,
    error: r.error,
    durationMs: r.duration_ms,
    output: r.output,
    createdAt: r.created_at,
  }));

  return { items, total, limit, offset };
}

// ── Stats ─────────────────────────────────────────────────────────

export async function getAuditStats(opts: {
  agentId?: AgentSlug;
  from?: Date;
  to?: Date;
  orgId?: string;
}): Promise<AuditStatsResult> {
  const instFilt = instanceFilter(opts.agentId);
  const orgFilt = buildOrgScopedAgentFilterFragment(opts.orgId);
  const fromFilt = opts.from ? sql`AND created_at >= ${toISO(opts.from)}` : sql``;
  const toFilt = opts.to ? sql`AND created_at <= ${toISO(opts.to)}` : sql``;

  const where = sql`WHERE 1=1 ${instFilt} ${orgFilt} ${fromFilt} ${toFilt}`;

  const [overviewResult, byToolResult, byActionResult] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int AS total_entries,
        COUNT(*) FILTER (WHERE success = false)::int AS error_count
      FROM tool_audit_logs
      ${where}
    `),
    db.execute(sql`
      SELECT tool_name, COUNT(*)::int AS count
      FROM tool_audit_logs
      ${where}
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT 20
    `),
    db.execute(sql`
      SELECT action, COUNT(*)::int AS count
      FROM tool_audit_logs
      ${where}
      GROUP BY action
      ORDER BY count DESC
      LIMIT 20
    `),
  ]);

  const overview = asRows<{ total_entries: number; error_count: number }>(overviewResult)[0] ?? {
    total_entries: 0,
    error_count: 0,
  };
  const totalEntries = overview.total_entries;
  const errorCount = overview.error_count;
  const errorRate = totalEntries > 0 ? errorCount / totalEntries : 0;

  const byTool = asRows<{ tool_name: string; count: number }>(byToolResult).map((r) => ({
    toolName: r.tool_name,
    count: r.count,
  }));

  const byAction = asRows<{ action: string; count: number }>(byActionResult).map((r) => ({
    action: r.action,
    count: r.count,
  }));

  return { totalEntries, errorCount, errorRate, byTool, byAction };
}
