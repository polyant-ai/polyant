// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AnalyticsActivityResponse, AnalyticsSummaryResponse, LatencyOverview } from "@/lib/api-types";

const latencyOverview: LatencyOverview = { p50: 0, p95: 0, p99: 0, avgTotal: 0, avgTtfb: null, sampleCount: 0 };

/** An empty window: every figure zero, every list empty, in the declared shape. */
export function makeAnalyticsSummary(): AnalyticsSummaryResponse {
  return {
    overview: {
      totalCost: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalConversations: 0,
      totalMessages: 0,
      uniqueUsers: 0,
      avgCostPerConversation: 0,
      avgResponseTime: 0,
      trends: { cost: null, conversations: null, messages: null, responseTime: null },
      previousPeriod: {
        totalCost: 0,
        totalConversations: 0,
        totalMessages: 0,
        avgResponseTime: 0,
        promptTokens: 0,
        cachedInputTokens: 0,
      },
    },
    dailyTrend: [],
    previousDailyCost: [],
    channelDistribution: [],
    dailyChannels: [],
    modelDistribution: [],
    tierDistribution: [],
    latency: { overview: latencyOverview, previousOverview: latencyOverview, dailyLatency: [], phaseBreakdown: [] },
  };
}

export function makeAnalyticsActivity(): AnalyticsActivityResponse {
  return { hourlyDistribution: [], toolUsage: [], latency: { slowestTools: [], toolTimings: [] } };
}
