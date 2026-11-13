// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, render, screen } from "@testing-library/react";

const i18n = { t: (key: string) => key, locale: "en", setLocale: vi.fn() };
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => i18n }));
vi.mock("@/lib/use-format", () => ({ useFormat: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("./date-range-picker", () => ({ DateRangePicker: () => null }));

// The charts themselves are covered by their own tests; here each one only says
// it was drawn, so the test reads which card holds data and which a placeholder.
const { drawn } = vi.hoisted(() => ({
  drawn: (name: string) => () => <div data-testid={`chart-${name}`} />,
}));
vi.mock("./kpi-cards", async (original) => ({
  ...(await original<typeof import("./kpi-cards")>()),
  KpiCards: drawn("kpis"),
}));
vi.mock("./cost-trend-chart", () => ({ CostTrendChart: drawn("cost") }));
vi.mock("./conversation-trend-chart", () => ({ ConversationTrendChart: drawn("conversations") }));
vi.mock("./latency-trend-chart", () => ({ LatencyTrendChart: drawn("latency") }));
vi.mock("./model-distribution-chart", () => ({ ModelDistributionChart: drawn("models") }));
vi.mock("./channel-distribution-chart", () => ({ ChannelDistributionChart: drawn("channels") }));
vi.mock("./instance-comparison-table", () => ({ InstanceComparisonTable: drawn("agents") }));
vi.mock("./tool-table", () => ({ ToolTable: drawn("tools") }));
vi.mock("./hourly-heatmap", () => ({ HourlyHeatmap: drawn("heatmap") }));

import { AnalyticsDashboard, type AnalyticsFetcher } from "./analytics-dashboard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("AnalyticsDashboard", () => {
  it("draws every card's title at once, then fills the summary before the activity", async () => {
    const summary = deferred<unknown>();
    const activity = deferred<unknown>();
    const fetchData = vi.fn((_from: string, _to: string, part: string) =>
      part === "summary" ? summary.promise : activity.promise,
    ) as unknown as AnalyticsFetcher;

    render(<AnalyticsDashboard fetchData={fetchData} showInstanceComparison />);

    // Before anything arrives: the layout with its real titles, every card a placeholder.
    expect(screen.getByText("analytics.kpi.cost")).toBeInTheDocument();
    expect(screen.getByText("analytics.charts.costTrend")).toBeInTheDocument();
    expect(screen.getByText("analytics.charts.tools")).toBeInTheDocument();
    expect(screen.getByText("analytics.charts.hourlyDistribution")).toBeInTheDocument();
    expect(screen.getByText("analytics.charts.instanceComparison")).toBeInTheDocument();
    expect(screen.queryByTestId(/^chart-/)).not.toBeInTheDocument();
    expect(fetchData).toHaveBeenCalledWith(expect.any(String), expect.any(String), "summary");
    expect(fetchData).toHaveBeenCalledWith(expect.any(String), expect.any(String), "activity");

    await act(async () => summary.resolve({ overview: {}, dailyTrend: [], latency: {} }));

    // The summary's cards are drawn; the two activity cards still wait, titled.
    for (const name of ["kpis", "cost", "conversations", "latency", "models", "channels", "agents"]) {
      expect(screen.getByTestId(`chart-${name}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("chart-tools")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chart-heatmap")).not.toBeInTheDocument();
    expect(screen.getByText("analytics.charts.tools")).toBeInTheDocument();

    await act(async () => activity.resolve({ hourlyDistribution: [], toolUsage: [], latency: {} }));

    expect(screen.getByTestId("chart-tools")).toBeInTheDocument();
    expect(screen.getByTestId("chart-heatmap")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
