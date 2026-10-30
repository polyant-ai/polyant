// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Spend on the analytics dashboard is what the provider billed.
 *
 * A call that dies at the provider after completing steps was billed for those
 * steps, and the gateway logs that cost on its `outcome = 'error'` row. The
 * dashboard summed cost over answered calls only, so it read lower than the
 * bill. Counts and averages still describe answered calls: a 300 ms failure must
 * not drag down the average response time of six-second answers.
 *
 * Integration, because the whole behaviour is the SQL predicate.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryClient } from "../database/client.js";
import { orgScope, type TenantScope } from "../authz/scope-filter.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { getAnalytics } from "./analytics.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-analytics-cost";
const AGENT = `${MARKER}-agent`;

let scope: TenantScope;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM ai_logs WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("analytics cost totals (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'a', false) RETURNING id`;
    const [{ id: wsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, 'a', false) RETURNING id`;
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${AGENT}, 'a', ${wsId})`;
    scope = orgScope(orgId);

    // One answered call, and one that failed after billing two steps.
    await queryClient`
      INSERT INTO ai_logs (provider, model, tier, prompt_tokens, completion_tokens, total_tokens,
                           estimated_cost_usd, duration_ms, instance_id, outcome, error_kind, created_at)
      VALUES ('openai', 'gpt-test', 'standard', 80, 20, 100, 1.0, 6000, ${AGENT}, 'ok', NULL, now() - interval '1 hour'),
             ('openai', 'gpt-test', 'standard', 25, 5, 30, 0.25, 300, ${AGENT}, 'error', 'timeout', now() - interval '1 hour')`;
  });

  afterAll(teardown);

  const range = () => ({ from: new Date(Date.now() - 24 * 3600_000), to: new Date() });

  it("counts the cost and tokens of failed calls in every spend total", async () => {
    const data = await getAnalytics(scope, range(), asInstanceSlug(AGENT));

    expect(data.overview.totalCost).toBeCloseTo(1.25);
    expect(data.overview.totalTokens).toBe(130);
    expect(data.dailyTrend.reduce((sum, d) => sum + d.cost, 0)).toBeCloseTo(1.25);
    expect(data.modelDistribution).toEqual([
      expect.objectContaining({ model: "gpt-test", cost: expect.closeTo(1.25), tokens: 130 }),
    ]);
    expect(data.tierDistribution).toEqual([
      expect.objectContaining({ tier: "standard", cost: expect.closeTo(1.25), tokens: 130 }),
    ]);
  });

  it("keeps call counts and response times to answered calls", async () => {
    const data = await getAnalytics(scope, range(), asInstanceSlug(AGENT));

    expect(data.overview.avgResponseTime).toBe(6000);
    expect(data.modelDistribution[0]).toEqual(expect.objectContaining({ calls: 1, avgDuration: 6000 }));
    expect(data.tierDistribution[0]).toEqual(expect.objectContaining({ calls: 1 }));
  });

  it("includes failed-call cost in the per-agent comparison", async () => {
    const data = await getAnalytics(scope, range(), undefined, true);

    expect(data.instanceComparison).toEqual([
      expect.objectContaining({ instanceId: AGENT, cost: expect.closeTo(1.25), tokens: 130 }),
    ]);
  });
});

describe.skipIf(!DB_AVAILABLE)("analytics over preempted turns and embedder calls (integration)", () => {
  // A turn the message coordinator preempted is logged `aborted` with what its
  // model calls cost; an embedder call is logged with its own call type. Both
  // are billed, so both reach the spend totals; neither is an answered model
  // call, so neither moves the response time.
  const EMBED_AGENT = `${MARKER}-embed-agent`;
  let embedScope: TenantScope;

  beforeAll(async () => {
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER + "-e"}, 'e', false) RETURNING id`;
    const [{ id: wsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER + "-e"}, 'e', false) RETURNING id`;
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${EMBED_AGENT}, 'e', ${wsId})`;
    embedScope = orgScope(orgId);

    await queryClient`
      INSERT INTO ai_logs (provider, model, tier, prompt_tokens, completion_tokens, total_tokens,
                           estimated_cost_usd, duration_ms, instance_id, outcome, call_type, created_at)
      VALUES ('openai', 'gpt-test', 'standard', 80, 20, 100, 1.0, 6000, ${EMBED_AGENT}, 'ok', 'conversation', now() - interval '1 hour'),
             ('openai', 'gpt-test', 'standard', 40, 10, 50, 0.1, 200, ${EMBED_AGENT}, 'aborted', 'conversation', now() - interval '1 hour'),
             ('openai', 'text-embedding-3-small', 'fast', 500, 0, 500, 0.01, 90, ${EMBED_AGENT}, 'ok', 'embedding', now() - interval '1 hour')`;
  });

  const range = () => ({ from: new Date(Date.now() - 24 * 3600_000), to: new Date() });

  it("counts both in the spend totals", async () => {
    const data = await getAnalytics(embedScope, range(), asInstanceSlug(EMBED_AGENT));

    expect(data.overview.totalCost).toBeCloseTo(1.11);
    expect(data.overview.totalTokens).toBe(650);
    expect(data.modelDistribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "gpt-test", cost: expect.closeTo(1.1), calls: 1 }),
        expect.objectContaining({ model: "text-embedding-3-small", callType: "embedding", cost: expect.closeTo(0.01), calls: 1 }),
      ]),
    );
  });

  it("keeps the response time and the tier breakdown to model calls", async () => {
    const data = await getAnalytics(embedScope, range(), asInstanceSlug(EMBED_AGENT));

    expect(data.overview.avgResponseTime).toBe(6000);
    expect(data.tierDistribution).toEqual([
      expect.objectContaining({ tier: "standard", cost: expect.closeTo(1.1), calls: 1 }),
    ]);
  });
});

describe.skipIf(!DB_AVAILABLE)("analytics against the previous window (integration)", () => {
  // The panel draws the previous window's cost under the current one and shows
  // the previous figures where a percentage says nothing, so both must come
  // from the window just before the one asked for, and only from it.
  const PREV_AGENT = `${MARKER}-prev-agent`;
  let prevScope: TenantScope;

  beforeAll(async () => {
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER + "-p"}, 'p', false) RETURNING id`;
    const [{ id: wsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER + "-p"}, 'p', false) RETURNING id`;
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${PREV_AGENT}, 'p', ${wsId})`;
    prevScope = orgScope(orgId);

    // One call in the current day, one in the day before it, one two days back.
    await queryClient`
      INSERT INTO ai_logs (provider, model, tier, prompt_tokens, completion_tokens, total_tokens, cached_input_tokens,
                           estimated_cost_usd, duration_ms, instance_id, outcome, created_at)
      VALUES ('openai', 'gpt-test', 'standard', 100, 0, 100, 80, 1.0, 1000, ${PREV_AGENT}, 'ok', now() - interval '1 hour'),
             ('openai', 'gpt-test', 'standard', 100, 0, 100, 40, 0.5, 1000, ${PREV_AGENT}, 'ok', now() - interval '30 hours'),
             ('openai', 'gpt-test', 'standard', 100, 0, 100, 0, 9.0, 1000, ${PREV_AGENT}, 'ok', now() - interval '60 hours')`;
  });

  const range = () => ({ from: new Date(Date.now() - 24 * 3600_000), to: new Date() });

  it("reads the previous window's cost per day and its cache sums", async () => {
    const data = await getAnalytics(prevScope, range(), asInstanceSlug(PREV_AGENT));

    expect(data.previousDailyCost.reduce((sum, d) => sum + d.cost, 0)).toBeCloseTo(0.5);
    expect(data.previousDailyCost.every((d) => d.dayOffset >= 0 && d.dayOffset <= 1)).toBe(true);
    expect(data.overview.previousPeriod).toEqual(
      expect.objectContaining({ totalCost: expect.closeTo(0.5), promptTokens: 100, cachedInputTokens: 40 }),
    );
    expect(data.dailyTrend.reduce((sum, d) => sum + d.cachedInputTokens, 0)).toBe(80);
  });

  it("returns every hour of every weekday, so the heatmap has no holes", async () => {
    const data = await getAnalytics(prevScope, range(), asInstanceSlug(PREV_AGENT));

    expect(data.hourlyDistribution).toHaveLength(7 * 24);
    expect(data.hourlyDistribution[0]).toEqual({ weekday: 0, hour: 0, count: 0 });
    expect(data.hourlyDistribution[7 * 24 - 1]).toEqual(expect.objectContaining({ weekday: 6, hour: 23 }));
  });
});
