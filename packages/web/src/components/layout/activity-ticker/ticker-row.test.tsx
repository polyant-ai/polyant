// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import type { FeedEvent } from "@/lib/activity-stream/types";
import { TickerRow } from "./ticker-row";

function inst(workspaceSlug: string) {
  return { id: "i1", slug: "a", name: "Sofia", icon: null, workspaceSlug };
}

const params = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

function ev(overrides: Partial<FeedEvent> & { id: string }): FeedEvent {
  return {
    ts: "2026-05-19T14:30:45.000Z",
    persona: "agent",
    text: "msg",
    ...overrides,
  };
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nProvider initialLocale="it">{ui}</I18nProvider>);
}

describe("TickerRow", () => {
  beforeEach(() => {
    params.current = { orgSlug: "acme", workspaceSlug: "main" };
  });

  test("links an event with a conversation to its tenant-scoped page", () => {
    renderWithI18n(<TickerRow ev={ev({ id: "a", conversationId: "inst-1:chat/42", instance: inst("main") })} />);
    const link = screen.getByRole("link", { name: /Apri conversazione/ });
    expect(link).toHaveAttribute(
      "href",
      "/organizations/acme/workspaces/main/conversations/inst-1%3Achat%2F42",
    );
  });

  test("renders no link for an event without a conversation", () => {
    renderWithI18n(<TickerRow ev={ev({ id: "b", instance: inst("main") })} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("renders no link outside an organization route", () => {
    params.current = {};
    renderWithI18n(<TickerRow ev={ev({ id: "c", conversationId: "inst-1:x", instance: inst("main") })} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("links to the agent's own workspace, not the one in the URL", () => {
    params.current = { orgSlug: "acme", workspaceSlug: "main" };
    renderWithI18n(<TickerRow ev={ev({ id: "d", conversationId: "inst-2:x", instance: inst("other") })} />);
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/organizations/acme/workspaces/other/conversations/inst-2%3Ax",
    );
  });

  test("renders no link when the event does not name the agent's workspace", () => {
    renderWithI18n(
      <TickerRow
        ev={ev({
          id: "e",
          conversationId: "inst-1:x",
          instance: { id: "i1", slug: "a", name: "Sofia", icon: null },
        })}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

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
