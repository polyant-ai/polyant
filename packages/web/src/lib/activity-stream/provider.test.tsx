// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ReactNode } from "react";
import {
  ActivityStreamProvider,
  useActivityStreamContext,
} from "./provider";
import type { FeedEvent } from "./types";

class MockEventSource {
  static last: MockEventSource | null = null;
  static instances = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.last = this;
    MockEventSource.instances += 1;
  }

  emit(payload: FeedEvent): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  close(): void {
    this.closed = true;
  }
}

const ORIGINAL = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.last = null;
  MockEventSource.instances = 0;
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
});

afterEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = ORIGINAL;
});

function wrapper({ children }: { children: ReactNode }) {
  return <ActivityStreamProvider>{children}</ActivityStreamProvider>;
}

function ev(overrides: Partial<FeedEvent> & { id: string }): FeedEvent {
  return {
    ts: "2026-05-19T10:00:00.000Z",
    persona: "agent",
    text: "msg",
    ...overrides,
  };
}

describe("ActivityStreamProvider", () => {
  test("opens a single EventSource regardless of consumer count", () => {
    renderHook(
      () => {
        useActivityStreamContext();
        useActivityStreamContext();
      },
      { wrapper },
    );
    expect(MockEventSource.instances).toBe(1);
  });

  test("appends events to state for list consumers", () => {
    const { result } = renderHook(() => useActivityStreamContext(), { wrapper });
    act(() => {
      MockEventSource.last!.emit(ev({ id: "e1", text: "hello" }));
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].id).toBe("e1");
  });

  test("notifies subscribers with merged events in arrival order", () => {
    const calls: string[] = [];
    const { result } = renderHook(() => useActivityStreamContext(), { wrapper });
    act(() => {
      result.current.subscribe((e) => calls.push(e.id));
    });
    act(() => {
      MockEventSource.last!.emit(ev({ id: "a" }));
      MockEventSource.last!.emit(ev({ id: "b" }));
    });
    expect(calls).toEqual(["a", "b"]);
  });

  test("filters noise events from both state and subscribers", () => {
    const calls: string[] = [];
    const { result } = renderHook(() => useActivityStreamContext(), { wrapper });
    act(() => {
      result.current.subscribe((e) => calls.push(e.id));
    });
    act(() => {
      MockEventSource.last!.emit(ev({ id: "noise", text: "" }));
      MockEventSource.last!.emit(ev({ id: "real", text: "ok" }));
    });
    expect(calls).toEqual(["real"]);
    expect(result.current.events.map((e) => e.id)).toEqual(["real"]);
  });

  test("unsubscribe removes the callback", () => {
    const calls: string[] = [];
    const { result } = renderHook(() => useActivityStreamContext(), { wrapper });
    let unsub: () => void = () => {};
    act(() => {
      unsub = result.current.subscribe((e) => calls.push(e.id));
    });
    act(() => {
      MockEventSource.last!.emit(ev({ id: "a" }));
    });
    act(() => {
      unsub();
    });
    act(() => {
      MockEventSource.last!.emit(ev({ id: "b" }));
    });
    expect(calls).toEqual(["a"]);
  });

  test("realLive flips true on open, false on error", () => {
    const { result } = renderHook(() => useActivityStreamContext(), { wrapper });
    expect(result.current.realLive).toBe(false);
    act(() => {
      MockEventSource.last!.onopen?.(new Event("open"));
    });
    expect(result.current.realLive).toBe(true);
    act(() => {
      MockEventSource.last!.onerror?.(new Event("error"));
    });
    expect(result.current.realLive).toBe(false);
  });
});
