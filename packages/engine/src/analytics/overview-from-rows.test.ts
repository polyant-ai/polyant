// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";

// The store module opens the database pools on import; this test needs neither.
vi.mock("../database/client.js", () => ({ db: {}, analyticsDb: {} }));

const { overviewFromRows } = await import("./analytics.store.js");

describe("overviewFromRows", () => {
  it("reads an empty tenant as zeros, with no trend to show", () => {
    const o = overviewFromRows(undefined, undefined, undefined, undefined);
    expect(o).toMatchObject({ totalCost: 0, totalConversations: 0, totalMessages: 0, avgCostPerConversation: 0 });
    // Nothing in the previous period either: no comparison, not "0%".
    expect(o.trends).toEqual({ cost: null, conversations: null, messages: null, responseTime: null });
  });

  it("derives averages and trends from the current and previous period", () => {
    const o = overviewFromRows(
      { total_cost: 10, total_tokens: 1000, prompt_tokens: 800, completion_tokens: 200, cached_input_tokens: 0, cache_creation_input_tokens: 0, avg_duration_ms: 1200, total_calls: 5 },
      { total_conversations: 4, total_messages: 20, unique_users: 3 },
      { total_cost: 5, prompt_tokens: 600, cached_input_tokens: 300, avg_duration_ms: 1000 },
      { total_conversations: 2, total_messages: 20 },
    );
    expect(o.avgCostPerConversation).toBe(2.5);
    expect(o.trends).toEqual({ cost: 100, conversations: 100, messages: 0, responseTime: 20 });
  });

  it("carries the previous period's absolute figures, for a change a percentage cannot express", () => {
    const o = overviewFromRows(
      undefined,
      undefined,
      { total_cost: 5, prompt_tokens: 600, cached_input_tokens: 300, avg_duration_ms: 1000 },
      { total_conversations: 2, total_messages: 20 },
    );
    expect(o.previousPeriod).toEqual({
      totalCost: 5,
      totalConversations: 2,
      totalMessages: 20,
      avgResponseTime: 1000,
      promptTokens: 600,
      cachedInputTokens: 300,
    });
  });
});
