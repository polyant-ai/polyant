// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import type { FeedEvent } from "@/lib/activity-stream/types";
import { TickerRow } from "./ticker-row";

function ev(overrides: Partial<FeedEvent> & { id: string }): FeedEvent {
  return {
    ts: "2026-05-19T14:30:45.000Z",
    persona: "agent",
    text: "msg",
    ...overrides,
  };
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("TickerRow", () => {
  test("renders narrative text", () => {
    renderWithI18n(
      <TickerRow
        ev={ev({
          id: "tool:end",
          text: "tool",
          instance: { id: "i1", slug: "agent", name: "Sofia", icon: "🤖" },
          tool: { name: "hubspotNote", summary: "search" },
          status: "success",
          durationMs: 100,
        })}
      />,
    );
    expect(screen.getByText(/Sofia/)).toBeInTheDocument();
    expect(screen.getByText(/hubspotNote/)).toBeInTheDocument();
  });

  test("renders timestamp", () => {
    renderWithI18n(
      <TickerRow
        ev={ev({
          id: "x",
          text: "msg",
          instance: { id: "i1", slug: "agent", name: "Sofia", icon: "🤖" },
        })}
      />,
    );
    expect(screen.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  test("does not render responsePreview or argsPreview", () => {
    const secret = "this-should-never-appear";
    renderWithI18n(
      <TickerRow
        ev={ev({
          id: "inbound",
          text: "in",
          category: "inbound",
          channel: { type: "telegram", id: "@u" },
          instance: { id: "i1", slug: "a", name: "Sofia", icon: null },
          responsePreview: secret,
          argsPreview: secret,
        })}
      />,
    );
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });
});
