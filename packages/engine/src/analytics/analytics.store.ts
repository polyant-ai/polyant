// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { type DateRange, toISO, asRows, pctChange, instanceFilter } from "../utils/query-helpers.js";
import { asInstanceSlug, type InstanceSlug } from "../instances/identifiers.js";
import { buildOrgScopedAgentFilterFragment } from "../authz/scope-filter.js";

export type { DateRange };

export interface OverviewStats {
  totalCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalConversations: number;
  totalMessages: number;
  uniqueUsers: number;
  avgCostPerConversation: number;
  avgResponseTime: number;
  trends: {
    cost: number;
    conversations: number;
    messages: number;
    responseTime: number;
  };
}

export interface DailyTrendRow {
  date: string;
  cost: number;
  tokens: number;
  conversations: number;
  messages: number;
}

export interface HourlyRow {
  hour: number;
  count: number;
}

export interface ChannelRow {
  channel: string;
  conversations: number;
  messages: number;
}

export interface ModelRow {
  provider: string;
  model: string;
  calls: number;
  tokens: number;
  cost: number;
  avgDuration: number;
}

export interface TierRow {
  tier: string;
  calls: number;
  tokens: number;
  cost: number;
}

export interface ToolRow {
  tool: string;
  count: number;
}

export interface InstanceComparisonRow {
  instanceId: InstanceSlug;
  name: string;
  conversations: number;
  cost: number;
  tokens: number;
}

export interface AnalyticsData {
  overview: OverviewStats;
  dailyTrend: DailyTrendRow[];
  hourlyDistribution: HourlyRow[];
  channelDistribution: ChannelRow[];
  modelDistribution: ModelRow[];
  tierDistribution: TierRow[];
  toolUsage: ToolRow[];
  instanceComparison?: InstanceComparisonRow[];
}

// ── Overview Stats ──────────────────────────────────────────────────

async function getOverviewStats(
  range: DateRange,
  instanceId?: InstanceSlug,
  orgId?: string,
): Promise<OverviewStats> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);
  const orgConv = buildOrgScopedAgentFilterFragment(orgId, "c.instance_id");

  // Current period — ai_logs
  const [aiStats] = asRows<{
    total_cost: number;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    avg_duration_ms: number;
    total_calls: number;
  }>(
    await db.execute(sql`
      SELECT
        COALESCE(SUM(estimated_cost_usd), 0)::float AS total_cost,
        COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
        COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
        COALESCE(AVG(duration_ms), 0)::float AS avg_duration_ms,
        COUNT(*)::int AS total_calls
      FROM ai_logs
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
    `),
  );

  // Current period — conversations
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const [convStats] = asRows<{
    total_conversations: number;
    total_messages: number;
    unique_users: number;
  }>(
    await db.execute(sql`
      SELECT
        COUNT(DISTINCT c.conversation_id)::int AS total_conversations,
        COALESCE(SUM(msg_count), 0)::int AS total_messages,
        COUNT(DISTINCT c.user_identifier)::int AS unique_users
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS msg_count
        FROM conversation_messages cm
        WHERE cm.conversation_id = c.conversation_id
      ) mc ON true
      WHERE c.created_at >= ${toISO(range.from)} AND c.created_at <= ${toISO(range.to)}
        ${convFilter} ${orgConv}
    `),
  );

  // Previous period (same duration, shifted back) for trends
  const durationMs = range.to.getTime() - range.from.getTime();
  const prevFrom = new Date(range.from.getTime() - durationMs);
  const prevTo = new Date(range.from.getTime());

  const [prevAi] = asRows<{
    total_cost: number;
    avg_duration_ms: number;
  }>(
    await db.execute(sql`
      SELECT
        COALESCE(SUM(estimated_cost_usd), 0)::float AS total_cost,
        COALESCE(AVG(duration_ms), 0)::float AS avg_duration_ms
      FROM ai_logs
      WHERE created_at >= ${toISO(prevFrom)} AND created_at <= ${toISO(prevTo)}
        ${instFilter} ${orgInst}
    `),
  );

  const [prevConv] = asRows<{
    total_conversations: number;
    total_messages: number;
  }>(
    await db.execute(sql`
      SELECT
        COUNT(DISTINCT c.conversation_id)::int AS total_conversations,
        COALESCE(SUM(msg_count), 0)::int AS total_messages
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS msg_count
        FROM conversation_messages cm
        WHERE cm.conversation_id = c.conversation_id
      ) mc ON true
      WHERE c.created_at >= ${toISO(prevFrom)} AND c.created_at <= ${toISO(prevTo)}
        ${convFilter} ${orgConv}
    `),
  );

  const totalConversations = convStats?.total_conversations ?? 0;
  const totalCost = aiStats?.total_cost ?? 0;

  return {
    totalCost,
    totalTokens: aiStats?.total_tokens ?? 0,
    promptTokens: aiStats?.prompt_tokens ?? 0,
    completionTokens: aiStats?.completion_tokens ?? 0,
    totalConversations,
    totalMessages: convStats?.total_messages ?? 0,
    uniqueUsers: convStats?.unique_users ?? 0,
    avgCostPerConversation: totalConversations > 0 ? totalCost / totalConversations : 0,
    avgResponseTime: aiStats?.avg_duration_ms ?? 0,
    trends: {
      cost: pctChange(totalCost, prevAi?.total_cost ?? 0),
      conversations: pctChange(totalConversations, prevConv?.total_conversations ?? 0),
      messages: pctChange(convStats?.total_messages ?? 0, prevConv?.total_messages ?? 0),
      responseTime: pctChange(aiStats?.avg_duration_ms ?? 0, prevAi?.avg_duration_ms ?? 0),
    },
  };
}

// ── Daily Trends ────────────────────────────────────────────────────

async function getDailyTrend(
  range: DateRange,
  instanceId?: InstanceSlug,
  orgId?: string,
): Promise<DailyTrendRow[]> {
  const instFilter = instanceFilter(instanceId);
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);
  const orgConv = buildOrgScopedAgentFilterFragment(orgId, "c.instance_id");

  const rows = asRows<{
    date: string;
    cost: number;
    tokens: number;
  }>(
    await db.execute(sql`
      SELECT
        DATE(created_at) AS date,
        COALESCE(SUM(estimated_cost_usd), 0)::float AS cost,
        COALESCE(SUM(total_tokens), 0)::int AS tokens
      FROM ai_logs
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
      GROUP BY DATE(created_at)
      ORDER BY date
    `),
  );

  const convRows = asRows<{
    date: string;
    conversations: number;
    messages: number;
  }>(
    await db.execute(sql`
      SELECT
        DATE(c.created_at) AS date,
        COUNT(DISTINCT c.conversation_id)::int AS conversations,
        COALESCE(SUM(msg_count), 0)::int AS messages
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS msg_count
        FROM conversation_messages cm
        WHERE cm.conversation_id = c.conversation_id
      ) mc ON true
      WHERE c.created_at >= ${toISO(range.from)} AND c.created_at <= ${toISO(range.to)}
        ${convFilter} ${orgConv}
      GROUP BY DATE(c.created_at)
      ORDER BY date
    `),
  );

  // Merge ai_logs and conversation data by date
  const dateMap = new Map<string, DailyTrendRow>();

  for (const r of rows) {
    const d = String(r.date);
    dateMap.set(d, { date: d, cost: r.cost, tokens: r.tokens, conversations: 0, messages: 0 });
  }
  for (const r of convRows) {
    const d = String(r.date);
    const existing = dateMap.get(d);
    if (existing) {
      existing.conversations = r.conversations;
      existing.messages = r.messages;
    } else {
      dateMap.set(d, { date: d, cost: 0, tokens: 0, conversations: r.conversations, messages: r.messages });
    }
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Hourly Distribution ─────────────────────────────────────────────

async function getHourlyDistribution(
  range: DateRange,
  instanceId?: InstanceSlug,
  orgId?: string,
): Promise<HourlyRow[]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(orgId, "c.instance_id");

  const rows = asRows<{ hour: number; count: number }>(
    await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM cm.created_at)::int AS hour,
        COUNT(*)::int AS count
      FROM conversation_messages cm
      JOIN conversations c ON c.conversation_id = cm.conversation_id
      WHERE cm.created_at >= ${toISO(range.from)} AND cm.created_at <= ${toISO(range.to)}
        AND cm.role = 'user'
        ${convFilter} ${orgConv}
      GROUP BY EXTRACT(HOUR FROM cm.created_at)
      ORDER BY hour
    `),
  );

  // Fill in missing hours with 0
  const hourMap = new Map(rows.map((r) => [r.hour, r.count]));
  return Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: hourMap.get(i) ?? 0,
  }));
}

// ── Channel Distribution ────────────────────────────────────────────

async function getChannelDistribution(
  range: DateRange,
  instanceId?: InstanceSlug,
  orgId?: string,
): Promise<ChannelRow[]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(orgId, "c.instance_id");

  return asRows<ChannelRow>(
    await db.execute(sql`
      SELECT
        CASE WHEN c.channel IN ('openai-api', '') OR c.channel IS NULL THEN 'web' ELSE c.channel END AS channel,
        COUNT(DISTINCT c.conversation_id)::int AS conversations,
        COALESCE(SUM(msg_count), 0)::int AS messages
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS msg_count
        FROM conversation_messages cm
        WHERE cm.conversation_id = c.conversation_id
      ) mc ON true
      WHERE c.created_at >= ${toISO(range.from)} AND c.created_at <= ${toISO(range.to)}
        ${convFilter} ${orgConv}
      GROUP BY CASE WHEN c.channel IN ('openai-api', '') OR c.channel IS NULL THEN 'web' ELSE c.channel END
      ORDER BY conversations DESC
    `),
  );
}

// ── Model Distribution ──────────────────────────────────────────────

async function getModelDistribution(
  range: DateRange,
  instanceId?: InstanceSlug,
  orgId?: string,
): Promise<ModelRow[]> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);

  return asRows<{
    provider: string;
    model: string;
    calls: number;
    tokens: number;
    cost: number;
    avg_duration: number;
  }>(
    await db.execute(sql`
      SELECT
        provider,
        model,
        COUNT(*)::int AS calls,
        COALESCE(SUM(total_tokens), 0)::int AS tokens,
        COALESCE(SUM(estimated_cost_usd), 0)::float AS cost,
        COALESCE(AVG(duration_ms), 0)::float AS avg_duration
      FROM ai_logs
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
      GROUP BY provider, model
      ORDER BY cost DESC
    `),
  ).map((r) => ({
    provider: r.provider,
    model: r.model,
    calls: r.calls,
    tokens: r.tokens,
    cost: r.cost,
    avgDuration: r.avg_duration,
  }));
}

// ── Tier Distribution ───────────────────────────────────────────────

async function getTierDistribution(
  range: DateRange,
  instanceId?: InstanceSlug,
  orgId?: string,
): Promise<TierRow[]> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(orgId);

  return asRows<TierRow>(
    await db.execute(sql`
      SELECT
        tier,
        COUNT(*)::int AS calls,
        COALESCE(SUM(total_tokens), 0)::int AS tokens,
        COALESCE(SUM(estimated_cost_usd), 0)::float AS cost
      FROM ai_logs
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
      GROUP BY tier
      ORDER BY cost DESC
    `),
  );
}

// ── Tool Usage ──────────────────────────────────────────────────────

async function getToolUsage(
  range: DateRange,
  instanceId?: InstanceSlug,
  orgId?: string,
): Promise<ToolRow[]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(orgId, "c.instance_id");

  // NOTE: migration 0038 renamed conversation_messages.tool_calls -> steps and
  // changed the shape from `[{toolName, args, result}]` to `StepDetail[]` where
  // each step has a `toolCalls: [{toolCallId, toolName, args}]` array. We
  // unwrap two levels: steps -> step.toolCalls -> toolName. Steps without a
  // toolCalls array (e.g. plain "initial" text steps) are filtered out.
  return asRows<ToolRow>(
    await db.execute(sql`
      SELECT
        tool_call->>'toolName' AS tool,
        COUNT(*)::int AS count
      FROM conversation_messages cm
      JOIN conversations c ON c.conversation_id = cm.conversation_id
      CROSS JOIN LATERAL jsonb_array_elements(cm.steps) AS step
      CROSS JOIN LATERAL jsonb_array_elements(step->'toolCalls') AS tool_call
      WHERE cm.created_at >= ${toISO(range.from)} AND cm.created_at <= ${toISO(range.to)}
        AND cm.steps IS NOT NULL
        AND jsonb_array_length(cm.steps) > 0
        AND jsonb_typeof(step->'toolCalls') = 'array'
        ${convFilter} ${orgConv}
      GROUP BY tool_call->>'toolName'
      ORDER BY count DESC
      LIMIT 20
    `),
  );
}

// ── Instance Comparison (global only) ───────────────────────────────

async function getInstanceComparison(
  range: DateRange,
  orgId?: string,
): Promise<InstanceComparisonRow[]> {
  const orgInst = buildOrgScopedAgentFilterFragment(orgId, "al.instance_id");
  return asRows<{
    instance_id: string;
    name: string;
    conversations: number;
    cost: number;
    tokens: number;
  }>(
    await db.execute(sql`
      SELECT
        al.instance_id,
        COALESCE(i.name, al.instance_id) AS name,
        COUNT(DISTINCT al.conversation_id)::int AS conversations,
        COALESCE(SUM(al.estimated_cost_usd), 0)::float AS cost,
        COALESCE(SUM(al.total_tokens), 0)::int AS tokens
      FROM ai_logs al
      LEFT JOIN instances i ON i.slug = al.instance_id
      WHERE al.created_at >= ${toISO(range.from)} AND al.created_at <= ${toISO(range.to)}
        AND al.instance_id IS NOT NULL
        ${orgInst}
      GROUP BY al.instance_id, i.name
      ORDER BY cost DESC
    `),
  ).map((r) => ({
    instanceId: asInstanceSlug(r.instance_id),
    name: r.name,
    conversations: r.conversations,
    cost: r.cost,
    tokens: r.tokens,
  }));
}

// ── Main Aggregator ─────────────────────────────────────────────────

export async function getAnalytics(
  range: DateRange,
  instanceId?: InstanceSlug,
  includeInstanceComparison = false,
  orgId?: string,
): Promise<AnalyticsData> {
  const [
    overview,
    dailyTrend,
    hourlyDistribution,
    channelDistribution,
    modelDistribution,
    tierDistribution,
    toolUsage,
    instanceComparison,
  ] = await Promise.all([
    getOverviewStats(range, instanceId, orgId),
    getDailyTrend(range, instanceId, orgId),
    getHourlyDistribution(range, instanceId, orgId),
    getChannelDistribution(range, instanceId, orgId),
    getModelDistribution(range, instanceId, orgId),
    getTierDistribution(range, instanceId, orgId),
    getToolUsage(range, instanceId, orgId),
    includeInstanceComparison ? getInstanceComparison(range, orgId) : Promise.resolve(undefined),
  ]);

  return {
    overview,
    dailyTrend,
    hourlyDistribution,
    channelDistribution,
    modelDistribution,
    tierDistribution,
    toolUsage,
    ...(instanceComparison ? { instanceComparison } : {}),
  };
}
