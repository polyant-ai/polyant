// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard's figures, field by field, on a small fixed history.
 *
 * The history has what makes the aggregates disagree when one of them is
 * wrong: answered, failed and preempted calls, an embedder call alone in its
 * tier, a service call, two agents, a call and a conversation at the exact
 * instant the window starts, and rows in the window before. Every expected
 * value below is worked out from the inserted rows, not read back from the
 * code under test.
 *
 * Another organization has a conversation and a turn on the same days: no
 * figure of this organization may count them.
 *
 * The windows: the current one is [2026-06-01, 2026-06-03], the previous one
 * the two days before. A row at 2026-06-01T00:00Z is in the current window, and
 * only there.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryClient } from "../database/client.js";
import { orgScope, type TenantScope } from "../authz/scope-filter.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { getAnalytics } from "./analytics.store.js";
import { getLatencyAnalytics } from "./latency.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-dashboard";
const AGENT = `${MARKER}-a`;
const OTHER = `${MARKER}-b`;
const FOREIGN = `${MARKER}-x`;
const RANGE = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-03T00:00:00Z") };

let scope: TenantScope;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM pipeline_traces WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM ai_logs WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("dashboard figures (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'd', false) RETURNING id`;
    const [{ id: wsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, 'd', false) RETURNING id`;
    await queryClient`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${AGENT}, 'Agent A', ${wsId}), (${OTHER}, 'Agent B', ${wsId})`;
    scope = orgScope(orgId);

    const [{ id: foreignOrgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${FOREIGN}, 'x', false) RETURNING id`;
    const [{ id: foreignWsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${foreignOrgId}, ${FOREIGN}, 'x', false) RETURNING id`;
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${FOREIGN}, 'Foreign', ${foreignWsId})`;
    await queryClient`
      INSERT INTO conversations (conversation_id, instance_id, channel, user_identifier, message_count, created_at, last_message_at)
      VALUES (${`${FOREIGN}-c`}, ${FOREIGN}, 'web', 'ux', 2, '2026-06-01T09:00:00Z', '2026-06-01T09:00:00Z')`;
    await queryClient`
      INSERT INTO pipeline_traces (conversation_id, instance_id, channel, total_ms, created_at)
      VALUES (${`${FOREIGN}-c`}, ${FOREIGN}, 'web', 700, '2026-06-01T09:00:00Z')`;

    const c1 = `${MARKER}-c1`;
    const c2 = `${MARKER}-c2`;
    const c3 = `${MARKER}-c3`;
    const cp = `${MARKER}-cp`;
    const cb = `${MARKER}-cb`;

    await queryClient`
      INSERT INTO ai_logs (provider, model, tier, call_type, outcome, prompt_tokens, completion_tokens, total_tokens,
                           cached_input_tokens, cache_creation_input_tokens, estimated_cost_usd, duration_ms,
                           instance_id, conversation_id, created_at)
      VALUES
        -- current window, agent A
        ('openai', 'gpt-a', 'standard', 'conversation', 'ok', 80, 20, 100, 10, 0, 0.5, 1000, ${AGENT}, ${c1}, '2026-06-01T00:00:00Z'),
        ('openai', 'gpt-a', 'standard', 'conversation', 'ok', 150, 50, 200, 50, 5, 1.0, 3000, ${AGENT}, ${c1}, '2026-06-01T10:00:00Z'),
        ('openai', 'gpt-a', 'standard', 'conversation', 'error', 25, 5, 30, 0, 0, 0.25, 300, ${AGENT}, ${c1}, '2026-06-02T10:00:00Z'),
        ('anthropic', 'claude-b', 'advanced', 'service', 'ok', 40, 10, 50, 0, 0, 0.1, 2000, ${AGENT}, ${c2}, '2026-06-02T11:00:00Z'),
        ('openai', 'embed-c', 'fast', 'embedding', 'ok', 500, 0, 500, 0, 0, 0.01, 90, ${AGENT}, ${c2}, '2026-06-02T12:00:00Z'),
        ('openai', 'gpt-a', 'standard', 'conversation', 'aborted', 30, 10, 40, 0, 0, 0.05, 200, ${AGENT}, ${c3}, '2026-06-02T13:00:00Z'),
        -- previous window, agent A (its start is inside, the instant before it is not)
        ('openai', 'gpt-a', 'standard', 'conversation', 'ok', 100, 0, 100, 40, 0, 2.0, 4000, ${AGENT}, ${cp}, '2026-05-31T12:00:00Z'),
        ('openai', 'gpt-a', 'standard', 'conversation', 'ok', 100, 0, 100, 0, 0, 0.5, 2000, ${AGENT}, ${cp}, '2026-05-30T00:00:00Z'),
        ('openai', 'gpt-a', 'standard', 'conversation', 'ok', 100, 0, 100, 0, 0, 9.0, 9000, ${AGENT}, ${cp}, '2026-05-29T23:59:00Z'),
        -- current window, agent B
        ('openai', 'gpt-a', 'standard', 'conversation', 'ok', 8, 2, 10, 0, 0, 3.0, 500, ${OTHER}, ${cb}, '2026-06-01T12:00:00Z')`;

    await queryClient`
      INSERT INTO conversations (conversation_id, instance_id, channel, user_identifier, message_count, created_at, last_message_at)
      VALUES (${c1}, ${AGENT}, 'web', 'u1', 4, '2026-06-01T00:00:00Z', '2026-06-01T10:30:00Z'),
             (${c2}, ${AGENT}, 'whatsapp', 'u2', 2, '2026-06-02T11:00:00Z', '2026-06-02T11:01:00Z'),
             (${c3}, ${AGENT}, NULL, 'u1', 2, '2026-06-02T13:00:00Z', '2026-06-02T13:00:00Z'),
             (${cp}, ${AGENT}, 'web', 'u3', 6, '2026-05-31T12:00:00Z', '2026-05-31T12:00:00Z')`;

    // 2026-06-01 is a Monday (weekday 0), 2026-06-02 a Tuesday.
    const steps = (...names: string[]) =>
      JSON.stringify([
        { stepType: "tool-result", toolCalls: names.map((toolName, i) => ({ toolCallId: `t${i}`, toolName, args: {} })) },
        { stepType: "initial", text: "done" },
      ]);
    await queryClient`
      INSERT INTO conversation_messages (conversation_id, role, content, steps, created_at)
      VALUES (${c1}, 'user', 'q', NULL, '2026-06-01T10:00:00Z'),
             (${c1}, 'assistant', 'a', ${steps("crm__lookup")}::jsonb, '2026-06-01T10:00:05Z'),
             (${c1}, 'user', 'q', NULL, '2026-06-01T10:30:00Z'),
             (${c1}, 'assistant', 'a', ${steps("crm__lookup", "calendar__book")}::jsonb, '2026-06-01T10:30:05Z'),
             (${c2}, 'user', 'q', NULL, '2026-06-02T11:00:00Z'),
             (${c2}, 'assistant', 'a', ${steps()}::jsonb, '2026-06-02T11:01:00Z'),
             (${cp}, 'user', 'q', NULL, '2026-05-31T12:00:00Z')`;

    const tools = (...calls: [string, number, boolean][]) =>
      JSON.stringify(calls.map(([name, duration_ms, success]) => ({ name, duration_ms, success })));
    await queryClient`
      INSERT INTO pipeline_traces (conversation_id, instance_id, channel, total_ms, ttfb_ms, context_prep_ms,
                                   tool_building_ms, llm_call_ms, tool_calls, created_at)
      VALUES (${c1}, ${AGENT}, 'web', 1000, 100, 10, 5, 800, ${tools(["crm:lookup", 100, true])}::jsonb, '2026-06-01T00:00:00Z'),
             (${c1}, ${AGENT}, 'web', 3000, 300, 30, 15, 2500,
              ${tools(["crm:lookup", 300, true], ["calendar:book", 900, false])}::jsonb, '2026-06-01T10:00:00Z'),
             (${c2}, ${AGENT}, 'web', 2000, NULL, 20, 10, 1500, '[]'::jsonb, '2026-06-02T10:00:00Z'),
             (${cp}, ${AGENT}, 'web', 5000, 500, 50, 25, 4000, NULL, '2026-05-31T12:00:00Z')`;
  });

  afterAll(teardown);

  it("composes the overview from the window's calls and conversations, and the window before", async () => {
    const { overview } = await getAnalytics(scope, RANGE, asInstanceSlug(AGENT));

    expect(overview).toEqual({
      totalCost: expect.closeTo(1.91, 6),
      totalTokens: 920,
      promptTokens: 825,
      completionTokens: 95,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 5,
      totalConversations: 3,
      totalMessages: 8,
      uniqueUsers: 2,
      avgCostPerConversation: expect.closeTo(1.91 / 3, 6),
      // Answered model calls only: 1000, 3000 and 2000 ms.
      avgResponseTime: 2000,
      trends: {
        cost: expect.closeTo(((1.91 - 2.5) / 2.5) * 100, 4),
        conversations: 200,
        messages: expect.closeTo(((8 - 6) / 6) * 100, 4),
        responseTime: expect.closeTo(((2000 - 3000) / 3000) * 100, 4),
      },
      previousPeriod: {
        totalCost: expect.closeTo(2.5, 6),
        totalConversations: 1,
        totalMessages: 6,
        avgResponseTime: 3000,
        promptTokens: 200,
        cachedInputTokens: 40,
      },
    });
  });

  it("splits the window by day, and the previous window's cost by day from its start", async () => {
    const data = await getAnalytics(scope, RANGE, asInstanceSlug(AGENT));

    expect(data.dailyTrend).toEqual([
      { date: "2026-06-01", cost: expect.closeTo(1.5, 6), tokens: 300, promptTokens: 230, cachedInputTokens: 60, conversations: 1, messages: 4 },
      { date: "2026-06-02", cost: expect.closeTo(0.41, 6), tokens: 620, promptTokens: 595, cachedInputTokens: 0, conversations: 2, messages: 4 },
    ]);
    // The same conversations by channel; c3 has none and is counted as web, as in the channel breakdown.
    expect(data.dailyChannels).toEqual([
      { date: "2026-06-01", channel: "web", conversations: 1 },
      { date: "2026-06-02", channel: "web", conversations: 1 },
      { date: "2026-06-02", channel: "whatsapp", conversations: 1 },
    ]);
    expect(data.previousDailyCost).toEqual([
      { dayOffset: 0, cost: expect.closeTo(0.5, 6) },
      { dayOffset: 1, cost: expect.closeTo(2.0, 6) },
    ]);
  });

  it("breaks spend down by model and by tier, the embedder in the first only", async () => {
    const data = await getAnalytics(scope, RANGE, asInstanceSlug(AGENT));

    expect(data.modelDistribution).toEqual([
      { provider: "openai", model: "gpt-a", callType: "conversation", calls: 2, tokens: 370, cost: expect.closeTo(1.8, 6), avgDuration: 2000 },
      { provider: "anthropic", model: "claude-b", callType: "service", calls: 1, tokens: 50, cost: expect.closeTo(0.1, 6), avgDuration: 2000 },
      { provider: "openai", model: "embed-c", callType: "embedding", calls: 1, tokens: 500, cost: expect.closeTo(0.01, 6), avgDuration: 90 },
    ]);
    expect(data.tierDistribution).toEqual([
      { tier: "standard", calls: 2, tokens: 370, cost: expect.closeTo(1.8, 6) },
      { tier: "advanced", calls: 1, tokens: 50, cost: expect.closeTo(0.1, 6) },
    ]);
  });

  it("counts people's messages by weekday and hour, conversations by channel, and tool calls by name", async () => {
    const data = await getAnalytics(scope, RANGE, asInstanceSlug(AGENT));

    const nonEmpty = data.hourlyDistribution.filter((cell) => cell.count > 0);
    expect(nonEmpty).toEqual([
      { weekday: 0, hour: 10, count: 2 },
      { weekday: 1, hour: 11, count: 1 },
    ]);
    expect(data.channelDistribution).toEqual([
      { channel: "web", conversations: 2, messages: 6 },
      { channel: "whatsapp", conversations: 1, messages: 2 },
    ]);
    expect(data.toolUsage).toEqual([
      { tool: "crm__lookup", count: 2 },
      { tool: "calendar__book", count: 1 },
    ]);
  });

  it("counts tool calls from the messages' steps, not from the turn traces", async () => {
    // Traces are deleted by the analytics retention and messages are not, so a
    // call that only a trace records (here a tool no message step names, and a
    // second call of one that does) must not change the counts.
    const ghost = JSON.stringify([
      { name: "ghost:tool", duration_ms: 10, success: true },
      { name: "crm:lookup", duration_ms: 10, success: true },
    ]);
    await queryClient`
      INSERT INTO pipeline_traces (conversation_id, instance_id, channel, total_ms, context_prep_ms,
                                   tool_building_ms, llm_call_ms, tool_calls, created_at)
      VALUES (${`${MARKER}-c1`}, ${AGENT}, 'web', 100, 1, 1, 50, ${ghost}::jsonb, '2026-06-01T10:45:00Z')`;
    try {
      const data = await getAnalytics(scope, RANGE, asInstanceSlug(AGENT));
      expect(data.toolUsage).toEqual([
        { tool: "crm__lookup", count: 2 },
        { tool: "calendar__book", count: 1 },
      ]);
    } finally {
      await queryClient`DELETE FROM pipeline_traces WHERE instance_id = ${AGENT} AND created_at = '2026-06-01T10:45:00Z'`;
    }
  });

  it("compares the organization's agents by spend", async () => {
    const data = await getAnalytics(scope, RANGE, undefined, true);

    expect(data.instanceComparison).toEqual([
      { instanceId: OTHER, name: "Agent B", conversations: 1, cost: expect.closeTo(3.0, 6), tokens: 10 },
      // Conversations with an answered call: c1 and c2; c3 only has a preempted one.
      { instanceId: AGENT, name: "Agent A", conversations: 2, cost: expect.closeTo(1.91, 6), tokens: 920 },
    ]);
  });

  it("reads response times overall, by day, by phase and by tool, and the window before", async () => {
    const latency = await getLatencyAnalytics(scope, RANGE, AGENT);

    expect(latency.overview).toEqual({ p50: 2000, p95: 2900, p99: 2980, avgTotal: 2000, avgTtfb: 200, sampleCount: 3 });
    expect(latency.previousOverview).toEqual({ p50: 5000, p95: 5000, p99: 5000, avgTotal: 5000, avgTtfb: 500, sampleCount: 1 });
    expect(latency.dailyLatency).toEqual([
      { date: "2026-06-01", p50: 2000, p95: 2900, p99: 2980, turns: 2 },
      { date: "2026-06-02", p50: 2000, p95: 2000, p99: 2000, turns: 1 },
    ]);
    expect(latency.phaseBreakdown).toEqual([
      { date: "2026-06-01", contextPrep: 20, toolBuilding: 10, llmCall: 1650 },
      { date: "2026-06-02", contextPrep: 20, toolBuilding: 10, llmCall: 1500 },
    ]);
    expect(latency.slowestTools).toEqual([
      { tool: "calendar:book", avgDurationMs: 900, callCount: 1, p95: 900, successRate: 0 },
      { tool: "crm:lookup", avgDurationMs: 200, callCount: 2, p95: 290, successRate: 1 },
    ]);
    expect(latency.toolTimings).toEqual([
      { tool: "crm__lookup", avgDurationMs: 200, callCount: 2, p95: 290, successRate: 1 },
      { tool: "calendar__book", avgDurationMs: 900, callCount: 1, p95: 900, successRate: 0 },
    ]);
  });

  it("keeps another organization's conversations and turns out of the daily splits", async () => {
    // Organization-wide, so only the scope keeps the foreign rows of 2026-06-01 out.
    const [data, latency] = await Promise.all([getAnalytics(scope, RANGE), getLatencyAnalytics(scope, RANGE)]);

    expect(data.dailyChannels).toEqual([
      { date: "2026-06-01", channel: "web", conversations: 1 },
      { date: "2026-06-02", channel: "web", conversations: 1 },
      { date: "2026-06-02", channel: "whatsapp", conversations: 1 },
    ]);
    expect(latency.dailyLatency.map(({ date, turns }) => ({ date, turns }))).toEqual([
      { date: "2026-06-01", turns: 2 },
      { date: "2026-06-02", turns: 1 },
    ]);
  });
});
