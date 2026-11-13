// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { ToolTable, mergeToolRows } from "./tool-table";
import { LatencyTrendChart } from "./latency-trend-chart";
import { KpiTile } from "./kpi-tile";
import { RankedBars } from "./ranked-bars";
import { HourlyHeatmap } from "./hourly-heatmap";
import { dailyCacheHitRates, dailyCostPerTurn, dailyValues, dayKey, eachDay } from "./daily-series";
import { channelSeries } from "./channel-trend-chart";
import type { ToolRow, ToolLatencyRow, LatencyDailyRow } from "@/lib/api";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key === "analytics.heatmap.weekdays" ? "Mon,Tue,Wed,Thu,Fri,Sat,Sun" : params ? `${key}:${JSON.stringify(params)}` : key,
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
  { tool: "web-search", avgDurationMs: 350, callCount: 40, p95: 800, successRate: 0.9 },
  { tool: "calculator", avgDurationMs: 12, callCount: 18, p95: 25, successRate: 1.0 },
  { tool: "only-traced", avgDurationMs: 90, callCount: 3, p95: 120, successRate: 1.0 },
];

const latencyDailyData: LatencyDailyRow[] = [
  { date: "2026-02-20", p50: 500, p95: 1200, p99: 3000, turns: 12 },
  { date: "2026-02-21", p50: 450, p95: 1100, p99: 2800, turns: 9 },
];

// ── Daily series ────────────────────────────────────────────────────

describe("daily series", () => {
  it("lists every day of the period, both ends included", () => {
    expect(eachDay("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });

  it("fills the days without activity, which the API leaves out", () => {
    const rows = [{ date: "2026-03-01", n: 5 }];
    expect(dailyValues(rows, eachDay("2026-02-28", "2026-03-02"), (r) => r.n)).toEqual([0, 5, 0]);
  });

  it("reads a date the API sent as a full timestamp", () => {
    expect(dayKey("2026-03-01T00:00:00.000Z")).toBe("2026-03-01");
  });

  it("rates each day's cache reads against its prompt, skipping days that sent none", () => {
    const rows = [
      { date: "2026-03-01", promptTokens: 1000, cachedInputTokens: 250 },
      // A day without a prompt has no rate, where a zero would draw a fall.
      { date: "2026-03-02", promptTokens: 0, cachedInputTokens: 0 },
      { date: "2026-03-04T00:00:00.000Z", promptTokens: 400, cachedInputTokens: 400 },
    ];
    expect(dailyCacheHitRates(rows, eachDay("2026-03-01", "2026-03-04"))).toEqual([0.25, null, null, 1]);
  });

  it("divides each day's cost by its turns, skipping days without turns", () => {
    const costs = [
      { date: "2026-03-01", cost: 1.5 },
      // Spend without a turn (a background summary): nothing to divide by.
      { date: "2026-03-02", cost: 0.2 },
      { date: "2026-03-03", cost: 0.9 },
    ];
    const turns = [
      { date: "2026-03-01", turns: 3 },
      { date: "2026-03-03", turns: 6 },
      // A turn on a day with no cost recorded costs nothing.
      { date: "2026-03-04", turns: 2 },
    ];
    expect(dailyCostPerTurn(costs, turns, eachDay("2026-03-01", "2026-03-05"))).toEqual([0.5, null, 0.15, 0, null]);
  });
});

describe("channel series", () => {
  it("ranks the channels by the period's conversations and folds the ones beyond the palette into one", () => {
    const rows = ["web", "whatsapp", "voice", "telegram", "slack", "email"].flatMap((channel, i) => [
      { date: "2026-03-01", channel, conversations: 10 - i },
      { date: "2026-03-02", channel, conversations: 10 - i },
    ]);
    // Whatsapp is behind web on each day they share and ahead over the period: the total decides.
    rows.push({ date: "2026-03-03", channel: "whatsapp", conversations: 3 });

    const { channels, hasOther } = channelSeries(rows);

    expect(channels.map((c) => c.channel)).toEqual(["whatsapp", "web", "voice", "telegram"]);
    expect(new Set(channels.map((c) => c.key)).size).toBe(4);
    expect(hasOther).toBe(true);
  });

  it("needs no other series when every channel has its colour", () => {
    expect(channelSeries([{ date: "2026-03-01", channel: "web", conversations: 1 }]).hasOther).toBe(false);
  });
});

// ── Tools ───────────────────────────────────────────────────────────

describe("ToolTable", () => {
  it("joins the usage counts with the timings of the same tool", () => {
    const rows = mergeToolRows(toolUsageData, toolLatencyData);
    expect(rows[0]).toEqual({ tool: "web-search", calls: 42, successRate: 0.9, p95: 800 });
    // Counted but never traced: no timing to show.
    expect(rows.find((r) => r.tool === "memory-recall")).toEqual(
      expect.objectContaining({ successRate: null, p95: null }),
    );
    // Traced but not counted: it still appears, with the traces' count.
    expect(rows.find((r) => r.tool === "only-traced")).toEqual(expect.objectContaining({ calls: 3 }));
  });

  it("shows the no-data message when there is nothing", () => {
    render(<ToolTable usage={[]} latency={[]} />);
    expect(screen.getByText("analytics.noData")).toBeInTheDocument();
  });

  it("marks a tool whose calls often fail", () => {
    render(<ToolTable usage={toolUsageData} latency={toolLatencyData} />);
    expect(screen.getByText("90.0%")).toHaveClass("text-destructive");
    for (const cell of screen.getAllByText("100.0%")) expect(cell).not.toHaveClass("text-destructive");
  });
});

// ── KPI tile ────────────────────────────────────────────────────────

describe("KpiTile", () => {
  it("shows the change against the previous period", () => {
    render(<KpiTile label="Cost" value="$59" trend={19.5} previous="$49" />);
    expect(screen.getByText("+19.5%")).toBeInTheDocument();
    expect(screen.getByText("analytics.kpi.vsPrevious")).toBeInTheDocument();
  });

  it("shows the previous figure where a percentage says nothing", () => {
    render(<KpiTile label="Conversations" value="13.3k" trend={1_100_000} previous="12" />);
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();
    expect(screen.getByText('analytics.kpi.previousValue:{"value":"12"}')).toBeInTheDocument();
  });

  it("colours by whether the move is good, not by its direction", () => {
    render(<KpiTile label="Response time" value="3.4 s" trend={-28.3} lowerIsBetter />);
    expect(screen.getByText("-28.3%").closest("span")).toHaveClass("text-success");
  });

  it("reads the change of a rate in points", () => {
    render(<KpiTile label="Cache" value="88%" trend={4.2} trendUnit="pt" />);
    expect(screen.getByText("+4 pt")).toBeInTheDocument();
  });
});

// ── Breakdowns and heatmap ──────────────────────────────────────────

describe("RankedBars", () => {
  it("writes each name in full with its share", () => {
    const name = "eu.anthropic.claude-haiku-5-5";
    render(
      <RankedBars
        rows={[
          { key: "a", label: name, value: 3 },
          { key: "b", label: "gpt", value: 1 },
        ]}
      />,
    );
    expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText("75% · 3")).toBeInTheDocument();
  });
});

describe("HourlyHeatmap", () => {
  it("draws one cell per hour of each weekday", () => {
    const data = Array.from({ length: 7 * 24 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24, count: i % 5 }));
    const { container } = render(<HourlyHeatmap data={data} />);
    expect(container.querySelectorAll("[title]")).toHaveLength(7 * 24);
  });

  it("shows the no-data message for an empty week", () => {
    render(<HourlyHeatmap data={[]} />);
    expect(screen.getByText("analytics.noData")).toBeInTheDocument();
  });
});

describe("LatencyTrendChart", () => {
  it("shows the no-data message when there are no traces", () => {
    render(<LatencyTrendChart data={[]} days={[]} />);
    expect(screen.getByText("analytics.noData")).toBeInTheDocument();
  });

  it("renders its title with data", () => {
    render(<LatencyTrendChart data={latencyDailyData} days={eachDay("2026-02-20", "2026-02-21")} />);
    expect(screen.getByText("analytics.charts.latencyTrend")).toBeInTheDocument();
  });
});
