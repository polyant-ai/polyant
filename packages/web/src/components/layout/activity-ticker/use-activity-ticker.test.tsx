// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { ActivityStreamProvider } from "@/lib/activity-stream/provider";
import type { FeedEvent } from "@/lib/activity-stream/types";
import { useActivityTicker, DWELL_MS, MICRO_QUEUE_CAP, STALE_AGE_MS } from "./use-activity-ticker";

class MockEventSource {
  static last: MockEventSource | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor() {
    MockEventSource.last = this;
  }
  emit(payload: FeedEvent): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
  close(): void {}
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

function wrapper({ children }: { children: ReactNode }) {
  return <ActivityStreamProvider>{children}</ActivityStreamProvider>;
}

function ev(overrides: Partial<FeedEvent> & { id: string }): FeedEvent {
  return {
    // Use the fake clock's "now" so the event isn't marked stale by the
    // ticker's STALE_AGE_MS filter. Tests that need a stale event should
    // override `ts` explicitly.
    ts: new Date().toISOString(),
    persona: "agent",
    text: "msg",
    ...overrides,
  };
}

function emit(e: FeedEvent) {
  act(() => {
    MockEventSource.last!.emit(e);
  });
}

describe("useActivityTicker", () => {
  test("current is null until first event arrives", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    expect(result.current.current).toBeNull();
  });

  test("first event becomes current", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    emit(ev({ id: "a" }));
    expect(result.current.current?.id).toBe("a");
  });

  test("second event waits in queue while first is in dwell", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    emit(ev({ id: "a" }));
    emit(ev({ id: "b" }));
    expect(result.current.current?.id).toBe("a");
  });

  test("after dwell expires, queue head becomes current", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    emit(ev({ id: "a" }));
    emit(ev({ id: "b" }));
    act(() => {
      vi.advanceTimersByTime(DWELL_MS);
    });
    expect(result.current.current?.id).toBe("b");
  });

  test("idle when queue drains", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    emit(ev({ id: "a" }));
    act(() => {
      vi.advanceTimersByTime(DWELL_MS);
    });
    expect(result.current.current).toBeNull();
  });

  test("drops oldest queued events when capacity exceeded", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    emit(ev({ id: "current" }));
    for (let i = 0; i < MICRO_QUEUE_CAP + 1; i += 1) {
      emit(ev({ id: `q${i}` }));
    }
    act(() => {
      vi.advanceTimersByTime(DWELL_MS);
    });
    expect(result.current.current?.id).toBe("q1");
  });

  test("same stepId in queue is replaced, not appended", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    emit(ev({ id: "holding" }));
    emit(ev({ id: "tool:c1:abc:start", text: "running" }));
    emit(ev({ id: "tool:c1:abc:end", text: "done" }));
    act(() => {
      vi.advanceTimersByTime(DWELL_MS);
    });
    expect(result.current.current?.id).toBe("tool:c1:abc:end");
    expect(result.current.current?.text).toBe("done");
  });

  test("same stepId as current updates current in place without restarting timer", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    emit(ev({ id: "tool:c1:abc:start", text: "running" }));
    act(() => {
      vi.advanceTimersByTime(DWELL_MS / 2);
    });
    emit(ev({ id: "tool:c1:abc:end", text: "done" }));
    expect(result.current.current?.id).toBe("tool:c1:abc:end");
    act(() => {
      vi.advanceTimersByTime(DWELL_MS / 2);
    });
    expect(result.current.current).toBeNull();
  });

  test("drops stale events on arrival (older than STALE_AGE_MS)", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    const staleTs = new Date(Date.now() - STALE_AGE_MS - 1000).toISOString();
    emit(ev({ id: "old", ts: staleTs }));
    expect(result.current.current).toBeNull();
  });

  test("drops queued events that became stale before draining", () => {
    const { result } = renderHook(() => useActivityTicker(), { wrapper });
    // First event is fresh and becomes current.
    emit(ev({ id: "fresh1" }));
    // Second event is fresh now and goes to queue.
    emit(ev({ id: "becomes-stale" }));
    // Advance well past STALE_AGE_MS so the queued event is now stale,
    // but use multiple short advances to trigger only one drain cycle.
    act(() => {
      vi.advanceTimersByTime(STALE_AGE_MS + DWELL_MS + 1000);
    });
    // After drain, current should be null — the queued event was dropped as stale.
    expect(result.current.current).toBeNull();
  });
});
