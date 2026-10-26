// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen, within } from "@testing-library/react";
import { renderWithProviders, userEvent } from "@/test-utils";
import { BacklogSection, type BacklogEvent } from "./room-backlog-section";
import { ActivityLogSection, type ActivityLog } from "./room-activity-section";

const EVENTS: BacklogEvent[] = [
  { id: "e2", status: "pending", rawPayload: { deal: "newer", amount: 90 }, createdAt: "2026-10-02T10:00:00Z", reactNotes: "Call the customer" },
  { id: "e1", status: "pending", rawPayload: { deal: "older" }, createdAt: "2026-10-01T10:00:00Z", reactNotes: null },
];

describe("BacklogSection", () => {
  it("keeps the engine's newest-first order instead of sorting by payload text", () => {
    renderWithProviders(<BacklogSection backlog={EVENTS} status="pending" onStatusChange={() => {}} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("newer");
    expect(rows[1]).toHaveTextContent("older");
  });

  it("finds an event by its payload or its notes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BacklogSection backlog={EVENTS} status="pending" onStatusChange={() => {}} />);
    await user.type(screen.getByRole("searchbox"), "customer");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("row", { name: /newer/ })).toBeInTheDocument();
  });

  it("opens the full payload in a drawer from the row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BacklogSection backlog={EVENTS} status="pending" onStatusChange={() => {}} />);
    await user.click(screen.getAllByRole("row")[1]);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText(/"amount": 90/)).toBeInTheDocument();
  });
});

const LOGS: ActivityLog[] = [
  { id: "l2", logDate: "2026-10-02", logType: "daily", content: "Closed two deals", eventCount: 2, createdAt: "" },
  { id: "l1", logDate: "2026-09-01", logType: "monthly", content: "A quiet month", eventCount: 0, createdAt: "" },
];

describe("ActivityLogSection", () => {
  it("keeps the given order and finds a summary by its text", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityLogSection activity={LOGS} />);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("2026");
    await user.type(screen.getByRole("searchbox"), "quiet");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("opens a summary's text in a drawer instead of expanding it in place", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityLogSection activity={LOGS} />);
    expect(screen.queryByText("Closed two deals")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("row")[1]);
    expect(within(await screen.findByRole("dialog")).getByText("Closed two deals")).toBeInTheDocument();
  });
});
