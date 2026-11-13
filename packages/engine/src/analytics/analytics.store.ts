// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { analyticsDb } from "../database/client.js";
import { type DateRange, toISO, asRows, pctChange, instanceFilter, previousRange } from "../utils/query-helpers.js";
import { asInstanceSlug, type InstanceSlug } from "../instances/identifiers.js";
import { buildOrgScopedAgentFilterFragment, type TenantScope } from "../authz/scope-filter.js";

export type { DateRange };

/**
 * Spend counts every call; counts and averages count calls that RETURNED.
 *
 * `ai_logs` gained an `outcome` column (migration 0077) so a turn that dies at
 * the provider leaves a row. That row carries the tokens and cost of the steps
 * the call completed before it failed (the provider billed them), and the
 * elapsed time before the failure. So the two kinds of aggregate split:
 *
 * - Cost and token SUMS include failed rows. Leaving them out made the
 *   dashboard read lower than the provider's bill, and lower than the
 *   conversation views, which sum every row.
 * - COUNT and AVG(duration_ms) keep to answered calls (`ANSWERED`). Otherwise
 *   `COUNT(*)` would become "calls attempted", and a 300 ms failure would join
 *   the average of six-second answers — two hundred failures beside two hundred
 *   answers report ~3.1 s where the answer is 6 s. How OFTEN calls fail is a
 *   different question, and `outcome` is where it is asked directly.
 *
 * `outcome` is `NOT NULL DEFAULT 'ok'`, so every row written before 0077 is an
 * answered call — the historical series does not move.
 *
 * Embedder calls (`call_type = 'embedding'`) are priced rows like any other, so
 * the sums count them. The overview's call count and response time measure
 * MODEL calls (`ANSWERED_MODEL_CALLS`): a 100 ms embedding beside every
 * retrieval would pull the average down and double the count. The per-model
 * breakdown keeps them — there each row is its own model — and the tier
 * breakdown leaves them out, an embedder having no tier.
 */
const ANSWERED = sql`FILTER (WHERE outcome = 'ok')`;
/** The same filter where `ai_logs` is aliased (see the per-agent query). */
const ANSWERED_AL = sql`FILTER (WHERE al.outcome = 'ok')`;
const ANSWERED_MODEL_CALLS = sql`FILTER (WHERE outcome = 'ok' AND call_type <> 'embedding')`;
/** Every model call, answered or not: the tier breakdown's rows, whose sums count failed calls too. */
const MODEL_CALLS = sql`FILTER (WHERE call_type <> 'embedding')`;

export interface OverviewStats {
  totalCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Prompt-cache reads (cache HIT). Subset of promptTokens. */
  cachedInputTokens: number;
  /** Prompt-cache writes (cache creation). Subset of promptTokens. */
  cacheCreationInputTokens: number;
  totalConversations: number;
  totalMessages: number;
  uniqueUsers: number;
  avgCostPerConversation: number;
  avgResponseTime: number;
  trends: {
    cost: number | null;
    conversations: number | null;
    messages: number | null;
    responseTime: number | null;
  };
  /**
   * The same window shifted back by its own duration, as absolute values. A
   * percentage says nothing when the previous figure is near zero, and the
   * panel then shows the previous figure itself; the cache hit rate is a rate,
   * so its change is read in points from these two sums.
   */
  previousPeriod: {
    totalCost: number;
    totalConversations: number;
    totalMessages: number;
    avgResponseTime: number;
    promptTokens: number;
    cachedInputTokens: number;
  };
}

export interface DailyTrendRow {
  date: string;
  cost: number;
  tokens: number;
  /** With `cachedInputTokens`, the day's cache hit rate. */
  promptTokens: number;
  cachedInputTokens: number;
  conversations: number;
  messages: number;
}

/** The previous window's daily cost, keyed by days since that window began. */
export interface PreviousDailyCostRow {
  dayOffset: number;
  cost: number;
}

/** Messages people sent, per day of the week (0 = Monday) and hour of the day. */
export interface HourlyRow {
  weekday: number;
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
  /** `ai_logs.call_type`: conversation, service (titles, summaries, checks) or embedding. */
  callType: string;
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
  previousDailyCost: PreviousDailyCostRow[];
  hourlyDistribution: HourlyRow[];
  channelDistribution: ChannelRow[];
  modelDistribution: ModelRow[];
  tierDistribution: TierRow[];
  toolUsage: ToolRow[];
  instanceComparison?: InstanceComparisonRow[];
}

/**
 * Narrows a message-level query to the conversations active in the window,
 * through idx_conversations_instance_last_message. Exact, not a heuristic: a
 * conversation with a message in [from, to] has its last message at or after
 * `from`. Without it Postgres probes every conversation the tenant ever had,
 * so the cost grew with its history instead of with the window.
 */
const ACTIVE_IN_WINDOW = (range: DateRange) => sql`AND c.last_message_at >= ${toISO(range.from)}`;

// ── ai_logs: one read per window ────────────────────────────────────

/**
 * Which grouping set an `ai_logs` row comes from: the bits of
 * `GROUPING(DATE(created_at), provider, tier)`, one per argument that the set
 * leaves out, the first argument the highest bit.
 */
const SET_TOTAL = 0b111;
const SET_DAY = 0b011;
const SET_MODEL = 0b101;
const SET_TIER = 0b110;

interface CurrentAiLogsRow {
  grouping_set: number;
  date: string | null;
  provider: string | null;
  model: string | null;
  call_type: string | null;
  tier: string | null;
  cost: number;
  tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  calls: number;
  avg_duration: number;
  model_call_rows: number;
  model_calls: number;
  model_avg_duration: number;
  model_call_tokens: number;
  model_call_cost: number;
}

interface CurrentAiLogs {
  overview: OverviewAiRow | undefined;
  daily: CurrentAiLogsRow[];
  models: ModelRow[];
  tiers: TierRow[];
}

/**
 * The window's `ai_logs` read ONCE for the overview, the daily trend and the
 * model and tier breakdowns. Each was its own scan of the same rows, so the
 * dashboard read the window four times; the grouping sets aggregate one scan
 * four ways. The tier set leaves embedder calls out with `FILTER` (an embedder
 * has no tier), where its own query did it in `WHERE`, and a tier with only
 * embedder rows is dropped.
 */
async function readCurrentAiLogs(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<CurrentAiLogs> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(scope);

  const rows = asRows<CurrentAiLogsRow>(
    await analyticsDb.execute(sql`
      SELECT
        GROUPING(DATE(created_at), provider, tier) AS grouping_set,
        DATE(created_at) AS date,
        provider,
        model,
        call_type,
        tier,
        COALESCE(SUM(estimated_cost_usd::float8), 0)::float AS cost,
        COALESCE(SUM(total_tokens), 0)::int AS tokens,
        COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
        COALESCE(SUM(cached_input_tokens), 0)::int AS cached_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)::int AS cache_creation_input_tokens,
        (COUNT(*) ${ANSWERED})::int AS calls,
        COALESCE(AVG(duration_ms) ${ANSWERED}, 0)::float AS avg_duration,
        (COUNT(*) ${MODEL_CALLS})::int AS model_call_rows,
        (COUNT(*) ${ANSWERED_MODEL_CALLS})::int AS model_calls,
        COALESCE(AVG(duration_ms) ${ANSWERED_MODEL_CALLS}, 0)::float AS model_avg_duration,
        COALESCE(SUM(total_tokens) ${MODEL_CALLS}, 0)::int AS model_call_tokens,
        COALESCE(SUM(estimated_cost_usd::float8) ${MODEL_CALLS}, 0)::float AS model_call_cost
      FROM ai_logs
      WHERE created_at >= ${toISO(range.from)} AND created_at <= ${toISO(range.to)}
        ${instFilter} ${orgInst}
      GROUP BY GROUPING SETS ((), (DATE(created_at)), (provider, model, call_type), (tier))
    `),
  );

  const total = rows.find((r) => r.grouping_set === SET_TOTAL);
  return {
    overview: total && {
      total_cost: total.cost,
      total_tokens: total.tokens,
      prompt_tokens: total.prompt_tokens,
      completion_tokens: total.completion_tokens,
      cached_input_tokens: total.cached_input_tokens,
      cache_creation_input_tokens: total.cache_creation_input_tokens,
      avg_duration_ms: total.model_avg_duration,
      total_calls: total.model_calls,
    },
    daily: rows.filter((r) => r.grouping_set === SET_DAY),
    models: rows
      .filter((r) => r.grouping_set === SET_MODEL)
      .sort((a, b) => b.cost - a.cost)
      .map((r) => ({
        provider: r.provider!,
        model: r.model!,
        callType: r.call_type!,
        calls: r.calls,
        tokens: r.tokens,
        cost: r.cost,
        avgDuration: r.avg_duration,
      })),
    tiers: rows
      .filter((r) => r.grouping_set === SET_TIER && r.model_call_rows > 0)
      .sort((a, b) => b.model_call_cost - a.model_call_cost)
      .map((r) => ({ tier: r.tier!, calls: r.model_calls, tokens: r.model_call_tokens, cost: r.model_call_cost })),
  };
}

interface PreviousAiLogsRow {
  grouping_set: number;
  day_offset: number | null;
  cost: number;
  prompt_tokens: number;
  cached_input_tokens: number;
  model_avg_duration: number;
}

/**
 * The previous window's `ai_logs`, read once for the overview's comparison and
 * the cost drawn under the current one. The window is half-open, `[from, to)`:
 * its end is the current window's start, and a row at that instant belongs to
 * the current window only.
 */
async function readPreviousAiLogs(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<{ overview: OverviewPrevAiRow | undefined; dailyCost: PreviousDailyCostRow[] }> {
  const instFilter = instanceFilter(instanceId);
  const orgInst = buildOrgScopedAgentFilterFragment(scope);
  const { from, to } = previousRange(range);

  const rows = asRows<PreviousAiLogsRow>(
    await analyticsDb.execute(sql`
      SELECT
        GROUPING(DATE(created_at)) AS grouping_set,
        (DATE(created_at) - DATE(${toISO(from)}::timestamptz))::int AS day_offset,
        COALESCE(SUM(estimated_cost_usd::float8), 0)::float AS cost,
        COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
        COALESCE(SUM(cached_input_tokens), 0)::int AS cached_input_tokens,
        COALESCE(AVG(duration_ms) ${ANSWERED_MODEL_CALLS}, 0)::float AS model_avg_duration
      FROM ai_logs
      WHERE created_at >= ${toISO(from)} AND created_at < ${toISO(to)}
        ${instFilter} ${orgInst}
      GROUP BY GROUPING SETS ((), (DATE(created_at)))
    `),
  );

  // `GROUPING(DATE(created_at))` is 1 on the whole window's row and 0 on each day's.
  const total = rows.find((r) => r.grouping_set === 1);
  return {
    overview: total && {
      total_cost: total.cost,
      prompt_tokens: total.prompt_tokens,
      cached_input_tokens: total.cached_input_tokens,
      avg_duration_ms: total.model_avg_duration,
    },
    dailyCost: rows
      .filter((r) => r.grouping_set === 0)
      .map((r) => ({ dayOffset: r.day_offset!, cost: r.cost }))
      .sort((a, b) => a.dayOffset - b.dayOffset),
  };
}

// ── Conversation totals ─────────────────────────────────────────────

/** The overview's conversation figures, current and previous window (half-open, as above). */
async function readConversationTotals(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<[OverviewConvRow | undefined, OverviewPrevConvRow | undefined]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");
  const { from: prevFrom, to: prevTo } = previousRange(range);

  const [current, previous] = await Promise.all([
    analyticsDb.execute(sql`
      SELECT
        COUNT(*)::int AS total_conversations,
        COALESCE(SUM(c.message_count), 0)::int AS total_messages,
        COUNT(DISTINCT c.user_identifier)::int AS unique_users
      FROM conversations c
      WHERE c.created_at >= ${toISO(range.from)} AND c.created_at <= ${toISO(range.to)}
        ${convFilter} ${orgConv}
    `),
    analyticsDb.execute(sql`
      SELECT
        COUNT(*)::int AS total_conversations,
        COALESCE(SUM(c.message_count), 0)::int AS total_messages
      FROM conversations c
      WHERE c.created_at >= ${toISO(prevFrom)} AND c.created_at < ${toISO(prevTo)}
        ${convFilter} ${orgConv}
    `),
  ]);
  return [asRows<OverviewConvRow>(current)[0], asRows<OverviewPrevConvRow>(previous)[0]];
}

/** The aggregate rows an overview is composed from, current and previous period. */
export interface OverviewAiRow {
  total_cost: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  avg_duration_ms: number;
  total_calls: number;
}
export interface OverviewConvRow {
  total_conversations: number;
  total_messages: number;
  unique_users: number;
}
export interface OverviewPrevAiRow {
  total_cost: number;
  prompt_tokens: number;
  cached_input_tokens: number;
  avg_duration_ms: number;
}
export interface OverviewPrevConvRow {
  total_conversations: number;
  total_messages: number;
}

/**
 * Compose an overview from its four aggregate rows. Pure, and exported so a
 * caller that reads the rows grouped by tenant (one query for many tenants)
 * composes each tenant's overview exactly as a single-tenant read does.
 */
export function overviewFromRows(
  aiStats: OverviewAiRow | undefined,
  convStats: OverviewConvRow | undefined,
  prevAi: OverviewPrevAiRow | undefined,
  prevConv: OverviewPrevConvRow | undefined,
): OverviewStats {
  const totalConversations = convStats?.total_conversations ?? 0;
  const totalCost = aiStats?.total_cost ?? 0;

  return {
    totalCost,
    totalTokens: aiStats?.total_tokens ?? 0,
    promptTokens: aiStats?.prompt_tokens ?? 0,
    completionTokens: aiStats?.completion_tokens ?? 0,
    cachedInputTokens: aiStats?.cached_input_tokens ?? 0,
    cacheCreationInputTokens: aiStats?.cache_creation_input_tokens ?? 0,
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
    previousPeriod: {
      totalCost: prevAi?.total_cost ?? 0,
      totalConversations: prevConv?.total_conversations ?? 0,
      totalMessages: prevConv?.total_messages ?? 0,
      avgResponseTime: prevAi?.avg_duration_ms ?? 0,
      promptTokens: prevAi?.prompt_tokens ?? 0,
      cachedInputTokens: prevAi?.cached_input_tokens ?? 0,
    },
  };
}

// ── Daily Trends ────────────────────────────────────────────────────

async function readDailyConversations(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<{ date: string; conversations: number; messages: number }[]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");

  return asRows(
    await analyticsDb.execute(sql`
      SELECT
        DATE(c.created_at) AS date,
        COUNT(*)::int AS conversations,
        COALESCE(SUM(c.message_count), 0)::int AS messages
      FROM conversations c
      WHERE c.created_at >= ${toISO(range.from)} AND c.created_at <= ${toISO(range.to)}
        ${convFilter} ${orgConv}
      GROUP BY DATE(c.created_at)
      ORDER BY date
    `),
  );
}

/** The day's spend from `ai_logs` beside the day's conversations, every day either has. */
function mergeDailyTrend(
  aiRows: readonly CurrentAiLogsRow[],
  convRows: readonly { date: string; conversations: number; messages: number }[],
): DailyTrendRow[] {
  const dateMap = new Map<string, DailyTrendRow>();

  for (const r of aiRows) {
    const d = String(r.date);
    dateMap.set(d, {
      date: d,
      cost: r.cost,
      tokens: r.tokens,
      promptTokens: r.prompt_tokens,
      cachedInputTokens: r.cached_input_tokens,
      conversations: 0,
      messages: 0,
    });
  }
  for (const r of convRows) {
    const d = String(r.date);
    const existing = dateMap.get(d);
    if (existing) {
      existing.conversations = r.conversations;
      existing.messages = r.messages;
    } else {
      dateMap.set(d, {
        date: d,
        cost: 0,
        tokens: 0,
        promptTokens: 0,
        cachedInputTokens: 0,
        conversations: r.conversations,
        messages: r.messages,
      });
    }
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Hourly Distribution ─────────────────────────────────────────────

async function getHourlyDistribution(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<HourlyRow[]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");

  const rows = asRows<{ weekday: number; hour: number; count: number }>(
    await analyticsDb.execute(sql`
      SELECT
        (EXTRACT(ISODOW FROM cm.created_at)::int - 1) AS weekday,
        EXTRACT(HOUR FROM cm.created_at)::int AS hour,
        COUNT(*)::int AS count
      FROM conversation_messages cm
      JOIN conversations c ON c.conversation_id = cm.conversation_id
      WHERE cm.created_at >= ${toISO(range.from)} AND cm.created_at <= ${toISO(range.to)}
        AND cm.role = 'user'
        ${ACTIVE_IN_WINDOW(range)}
        ${convFilter} ${orgConv}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `),
  );

  // Every cell of the week, empty ones included, so the grid never has holes.
  const counts = new Map(rows.map((r) => [r.weekday * 24 + r.hour, r.count]));
  return Array.from({ length: 7 * 24 }, (_, i) => ({
    weekday: Math.floor(i / 24),
    hour: i % 24,
    count: counts.get(i) ?? 0,
  }));
}

// ── Channel Distribution ────────────────────────────────────────────

async function getChannelDistribution(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<ChannelRow[]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");

  return asRows<ChannelRow>(
    await analyticsDb.execute(sql`
      SELECT
        CASE WHEN c.channel IN ('openai-api', '') OR c.channel IS NULL THEN 'web' ELSE c.channel END AS channel,
        COUNT(*)::int AS conversations,
        COALESCE(SUM(c.message_count), 0)::int AS messages
      FROM conversations c
      WHERE c.created_at >= ${toISO(range.from)} AND c.created_at <= ${toISO(range.to)}
        ${convFilter} ${orgConv}
      GROUP BY CASE WHEN c.channel IN ('openai-api', '') OR c.channel IS NULL THEN 'web' ELSE c.channel END
      ORDER BY conversations DESC
    `),
  );
}

// ── Tool Usage ──────────────────────────────────────────────────────

/**
 * How often each tool was called, from the tool calls in the assistant
 * messages' `steps`. The messages are the source because they are kept as
 * long as the conversation: the turn traces would be cheaper to read, but the
 * analytics retention deletes them, and a window longer than that retention
 * would then show less use than happened.
 */
async function getToolUsage(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<ToolRow[]> {
  const convFilter = instanceFilter(instanceId, "c.instance_id");
  const orgConv = buildOrgScopedAgentFilterFragment(scope, "c.instance_id");

  // NOTE: migration 0038 renamed conversation_messages.tool_calls -> steps and
  // changed the shape from `[{toolName, args, result}]` to `StepDetail[]` where
  // each step has a `toolCalls: [{toolCallId, toolName, args}]` array. We
  // unwrap two levels: steps -> step.toolCalls -> toolName. Steps without a
  // toolCalls array (e.g. plain "initial" text steps) are filtered out.
  return asRows<ToolRow>(
    await analyticsDb.execute(sql`
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
        ${ACTIVE_IN_WINDOW(range)}
        ${convFilter} ${orgConv}
      GROUP BY tool_call->>'toolName'
      ORDER BY count DESC
      LIMIT 20
    `),
  );
}

// ── Instance Comparison (global only) ───────────────────────────────

async function getInstanceComparison(
  scope: TenantScope,
  range: DateRange,
): Promise<InstanceComparisonRow[]> {
  const orgInst = buildOrgScopedAgentFilterFragment(scope, "al.instance_id");
  return asRows<{
    instance_id: string;
    name: string;
    conversations: number;
    cost: number;
    tokens: number;
  }>(
    // Aggregated BEFORE the join: joining first looked up the agent's name for
    // every row of the window instead of once per agent.
    await analyticsDb.execute(sql`
      SELECT a.instance_id, COALESCE(i.name, a.instance_id) AS name, a.conversations, a.cost, a.tokens
      FROM (
        SELECT
          al.instance_id,
          (COUNT(DISTINCT al.conversation_id) ${ANSWERED_AL})::int AS conversations,
          COALESCE(SUM(al.estimated_cost_usd::float8), 0)::float AS cost,
          COALESCE(SUM(al.total_tokens), 0)::int AS tokens
        FROM ai_logs al
        WHERE al.created_at >= ${toISO(range.from)} AND al.created_at <= ${toISO(range.to)}
          AND al.instance_id IS NOT NULL
          ${orgInst}
        GROUP BY al.instance_id
      ) a
      LEFT JOIN instances i ON i.slug = a.instance_id
      ORDER BY a.cost DESC
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

/**
 * The dashboard split in two by cost. The summary reads `ai_logs` and the
 * conversations' own counters through their indexes; the activity reads the
 * MESSAGES — the hourly grid and the tool counts that unnest every message's
 * `steps` — and is what grows with the volume. The panel asks for the two
 * separately, so the numbers on top do not wait for the slow half.
 */
export type AnalyticsSummary = Omit<AnalyticsData, "hourlyDistribution" | "toolUsage">;
export type AnalyticsActivity = Pick<AnalyticsData, "hourlyDistribution" | "toolUsage">;

export async function getAnalyticsSummary(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
  includeInstanceComparison = false,
): Promise<AnalyticsSummary> {
  const [current, previous, [convStats, prevConv], dailyConversations, channelDistribution, instanceComparison] =
    await Promise.all([
      readCurrentAiLogs(scope, range, instanceId),
      readPreviousAiLogs(scope, range, instanceId),
      readConversationTotals(scope, range, instanceId),
      readDailyConversations(scope, range, instanceId),
      getChannelDistribution(scope, range, instanceId),
      includeInstanceComparison ? getInstanceComparison(scope, range) : Promise.resolve(undefined),
    ]);

  return {
    overview: overviewFromRows(current.overview, convStats, previous.overview, prevConv),
    dailyTrend: mergeDailyTrend(current.daily, dailyConversations),
    previousDailyCost: previous.dailyCost,
    channelDistribution,
    modelDistribution: current.models,
    tierDistribution: current.tiers,
    ...(instanceComparison ? { instanceComparison } : {}),
  };
}

export async function getAnalyticsActivity(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
): Promise<AnalyticsActivity> {
  const [hourlyDistribution, toolUsage] = await Promise.all([
    getHourlyDistribution(scope, range, instanceId),
    getToolUsage(scope, range, instanceId),
  ]);
  return { hourlyDistribution, toolUsage };
}

export async function getAnalytics(
  scope: TenantScope,
  range: DateRange,
  instanceId?: InstanceSlug,
  includeInstanceComparison = false,
): Promise<AnalyticsData> {
  const [summary, activity] = await Promise.all([
    getAnalyticsSummary(scope, range, instanceId, includeInstanceComparison),
    getAnalyticsActivity(scope, range, instanceId),
  ]);
  return { ...summary, ...activity };
}
