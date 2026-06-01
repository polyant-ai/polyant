// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { ActivityStreamProvider } from "@/lib/activity-stream/provider";
import { I18nProvider } from "@/lib/i18n/context";
import type { FeedEvent } from "@/lib/activity-stream/types";
import { ActivityTicker } from "./activity-ticker";

class MockEventSource {
  static last: MockEventSource | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    MockEventSource.last = this;
  }
  emit(payload: FeedEvent) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
  close() {}
}

const ORIGINAL = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.last = null;
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = ORIGINAL;
  vi.useRealTimers();
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ActivityStreamProvider>{children}</ActivityStreamProvider>
    </I18nProvider>
  );
}

function ev(id: string, name = "Sofia"): FeedEvent {
  return {
    id,
    ts: new Date().toISOString(),
    persona: "agent",
    text: "msg",
    instance: { id: "i1", slug: "sofia", name, icon: "🤖" },
  };
}

describe("ActivityTicker", () => {
  test("renders the aria-live region with no content when idle", () => {
    render(
      <Wrapper>
        <ActivityTicker />
      </Wrapper>,
    );
    const region = screen.getByRole("status");
    expect(region.textContent ?? "").toBe("");
  });

  test("renders current event when one arrives", () => {
    render(
      <Wrapper>
        <ActivityTicker />
      </Wrapper>,
    );
    act(() => {
      MockEventSource.last!.emit(ev("a", "Sofia"));
    });
    expect(screen.getByText(/Sofia/)).toBeInTheDocument();
  });

  test("aria-live region present for screen readers", () => {
    render(
      <Wrapper>
        <ActivityTicker />
      </Wrapper>,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });
});
