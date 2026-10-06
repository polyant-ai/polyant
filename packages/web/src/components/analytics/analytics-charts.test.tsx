// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { ToolUsageChart } from "./tool-usage-chart";
import { ToolLatencyTable } from "./tool-latency-table";
import { LatencyTrendChart } from "./latency-trend-chart";
import type { ToolRow, ToolLatencyRow, LatencyDailyRow } from "@/lib/api";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

// recharts ResponsiveContainer needs ResizeObserver
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// ── Fixtures ────────────────────────────────────────────────────────

const toolUsageData: ToolRow[] = [
  { tool: "web-search", count: 42 },
  { tool: "calculator", count: 18 },
  { tool: "memory-recall", count: 7 },
];

const toolLatencyData: ToolLatencyRow[] = [
  { tool: "web-search", avgDurationMs: 350, callCount: 42, p95: 800, successRate: 0.95 },
  { tool: "calculator", avgDurationMs: 12, callCount: 18, p95: 25, successRate: 1.0 },
];

const latencyDailyData: LatencyDailyRow[] = [
  { date: "2026-02-20", p50: 500, p95: 1200, p99: 3000 },
  { date: "2026-02-21", p50: 450, p95: 1100, p99: 2800 },
];

// ── Empty state tests ───────────────────────────────────────────────

describe("Chart empty states", () => {
  it("ToolUsageChart shows no-data message when data is empty", () => {
    render(<ToolUsageChart data={[]} />);
    expect(screen.getByText("analytics.noData")).toBeInTheDocument();
  });

  it("ToolLatencyTable shows no-data message when data is empty", () => {
    render(<ToolLatencyTable data={[]} />);
    expect(screen.getByText("analytics.noData")).toBeInTheDocument();
  });

  it("LatencyTrendChart shows no-data message when data is empty", () => {
    render(<LatencyTrendChart data={[]} />);
    expect(screen.getByText("analytics.noData")).toBeInTheDocument();
  });
});

// ── Render tests with data ──────────────────────────────────────────

describe("Chart rendering with data", () => {
  it("ToolUsageChart renders title with data", () => {
    render(<ToolUsageChart data={toolUsageData} />);
    expect(screen.getByText("analytics.charts.toolUsage")).toBeInTheDocument();
  });

  it("ToolLatencyTable renders title with data", () => {
    render(<ToolLatencyTable data={toolLatencyData} />);
    expect(screen.getByText("analytics.charts.toolLatency")).toBeInTheDocument();
  });

  it("LatencyTrendChart renders title with data", () => {
    render(<LatencyTrendChart data={latencyDailyData} />);
    expect(screen.getByText("analytics.charts.latencyTrend")).toBeInTheDocument();
  });
});
