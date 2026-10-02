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
  await queryClient`DELETE FROM ai_logs WHERE instance_id = ${AGENT}`;
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
