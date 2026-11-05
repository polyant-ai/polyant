// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two sections whose code loads when they open. Until it arrives the
 * section shows its skeleton, as the other sections do while their data loads,
 * instead of an empty body.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const chunks = vi.hoisted(() => {
  let analytics!: () => void;
  let room!: () => void;
  return {
    analytics: new Promise<void>((resolve) => { analytics = resolve; }),
    room: new Promise<void>((resolve) => { room = resolve; }),
    arrive: { analytics: () => analytics(), room: () => room() },
  };
});
vi.mock("./analytics-tab", async () => {
  await chunks.analytics;
  return { AnalyticsTab: () => <div>analytics body</div> };
});
vi.mock("./room-tab", async () => {
  await chunks.room;
  return { RoomTab: () => <div>room body</div> };
});

import { AnalyticsTab, RoomTab } from "./lazy-sections";

describe("sections loaded when they open", () => {
  it.each([
    ["Analytics", AnalyticsTab, "analytics body", () => chunks.arrive.analytics()],
    ["Room", RoomTab, "room body", () => chunks.arrive.room()],
  ] as const)("shows the %s skeleton until its code arrives", async (_name, Section, body, arrive) => {
    const { container } = render(<Section slug="agent" />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    arrive();
    expect(await screen.findByText(body)).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
