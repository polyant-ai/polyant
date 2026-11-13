// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSummary, mockActivity, mockLatencySummary, mockLatencyActivity } = vi.hoisted(() => ({
  mockSummary: vi.fn(),
  mockActivity: vi.fn(),
  mockLatencySummary: vi.fn(),
  mockLatencyActivity: vi.fn(),
}));

vi.mock("./analytics.store.js", () => ({
  getAnalyticsSummary: mockSummary,
  getAnalyticsActivity: mockActivity,
}));
vi.mock("./latency.store.js", () => ({
  getLatencySummary: mockLatencySummary,
  getLatencyActivity: mockLatencyActivity,
}));

import { clearDashboardCache, readDashboard, type DashboardRequest } from "./dashboard-read.js";
import { orgScope, orgWorkspacesScope } from "../authz/scope-filter.js";
import { asInstanceSlug } from "../instances/identifiers.js";

const range = { from: new Date("2026-01-01"), to: new Date("2026-01-31T23:59:59.999Z") };

function request(overrides: Partial<DashboardRequest> = {}): DashboardRequest {
  return { scope: orgScope("org-1"), range, includeInstanceComparison: true, ...overrides };
}

describe("readDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDashboardCache();
    mockSummary.mockResolvedValue({ overview: { totalCost: 3 } });
    mockActivity.mockResolvedValue({ hourlyDistribution: [], toolUsage: [{ tool: "search", count: 2 }] });
    mockLatencySummary.mockResolvedValue({ overview: { p50: 100 }, dailyLatency: [] });
    mockLatencyActivity.mockResolvedValue({ slowestTools: [], toolTimings: [{ tool: "search" }] });
  });

  it("the summary half never runs the message-level reads", async () => {
    const summary = await readDashboard(request(), "summary");

    expect(summary).toEqual({ overview: { totalCost: 3 }, latency: { overview: { p50: 100 }, dailyLatency: [] } });
    expect(mockActivity).not.toHaveBeenCalled();
    expect(mockLatencyActivity).not.toHaveBeenCalled();
  });

  it("without a part answers both halves, latency fields merged into one object", async () => {
    const whole = await readDashboard(request());

    expect(whole).toEqual({
      overview: { totalCost: 3 },
      hourlyDistribution: [],
      toolUsage: [{ tool: "search", count: 2 }],
      latency: { overview: { p50: 100 }, dailyLatency: [], slowestTools: [], toolTimings: [{ tool: "search" }] },
    });
  });

  it("a whole read after a half reuses that half instead of reading it again", async () => {
    await readDashboard(request(), "summary");
    await readDashboard(request());

    expect(mockSummary).toHaveBeenCalledTimes(1);
    expect(mockActivity).toHaveBeenCalledTimes(1);
  });

  it("scopes that name the same id under different shapes do not share an answer", async () => {
    await readDashboard(request({ scope: orgScope("x") }), "summary");
    await readDashboard(request({ scope: orgWorkspacesScope("x", new Set(["x"])) }), "summary");

    expect(mockSummary).toHaveBeenCalledTimes(2);
  });

  it("one agent's dashboard is not its workspace's", async () => {
    await readDashboard(request(), "summary");
    await readDashboard(request({ instanceId: asInstanceSlug("bot"), includeInstanceComparison: false }), "summary");

    expect(mockSummary).toHaveBeenCalledTimes(2);
    expect(mockSummary).toHaveBeenLastCalledWith(orgScope("org-1"), range, "bot", false);
  });
});
