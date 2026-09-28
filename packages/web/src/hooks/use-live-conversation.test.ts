// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { currentTurn, useLiveConversation } from "./use-live-conversation";
import type { FeedEvent } from "@/lib/activity-stream/types";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  listeners: Record<string, () => void> = {};
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: () => void) {
    this.listeners[name] = fn;
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const props = { conversationId: "agent-a:whatsapp:39", instanceId: "agent-a" };

describe("useLiveConversation", () => {
  it("opens nothing while disabled", () => {
    renderHook(() => useLiveConversation({ ...props, enabled: false, onPersisted: vi.fn() }));

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("collects the conversation's events once each and closes on disable", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useLiveConversation({ ...props, enabled, onPersisted: vi.fn() }),
      { initialProps: { enabled: true } },
    );
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/activity-stream/conversation?conversationId=agent-a%3Awhatsapp%3A39&instanceId=agent-a");

    const frame = { data: JSON.stringify({ id: "e1", ts: "t", persona: "agent", text: "x" }) };
    act(() => {
      source.onopen?.();
      source.onmessage?.(frame);
      source.onmessage?.(frame);
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.events.map((e) => e.id)).toEqual(["e1"]);

    rerender({ enabled: false });
    expect(source.closed).toBe(true);
    expect(result.current.events).toEqual([]);
  });

  it("folds a tool's start and end events into one", () => {
    const { result } = renderHook(() => useLiveConversation({ ...props, enabled: true, onPersisted: vi.fn() }));
    const source = FakeEventSource.instances[0];
    const tool = { persona: "agent", text: "t", tool: { name: "t", summary: "" } };

    act(() => {
      source.onmessage?.({ data: JSON.stringify({ ...tool, id: "tool:c:1:start", ts: "2026-09-27T10:00:00.000Z" }) });
      source.onmessage?.({ data: JSON.stringify({ ...tool, id: "tool:c:1:end", ts: "2026-09-27T10:00:02.000Z", status: "success" }) });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].status).toBe("success");
  });

  it("re-reads once for a burst of stored writes", () => {
    const onPersisted = vi.fn();
    renderHook(() => useLiveConversation({ ...props, enabled: true, onPersisted }));
    const source = FakeEventSource.instances[0];

    act(() => {
      source.listeners.persisted();
      source.listeners.persisted();
      source.listeners.persisted();
      vi.advanceTimersByTime(250);
    });

    expect(onPersisted).toHaveBeenCalledTimes(1);
  });
});

describe("currentTurn", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 27, 10, 0, s)).toISOString();
  const ms = (s: number) => new Date(at(s)).getTime();
  const inbound = (id: string, s: number): FeedEvent => ({ id, ts: at(s), persona: "agent", category: "inbound", text: id });
  const reply = (id: string, s: number): FeedEvent => ({ id, ts: at(s), persona: "agent", text: id });

  it("keeps the turn that started with an incoming message not yet stored", () => {
    const events = [inbound("in1", 1), reply("r1", 4), inbound("in2", 20), reply("tool2", 21)];
    // Turn 1 stored: its user row was stamped at arrival, just before its event.
    expect(currentTurn(events, [ms(0.9)], ms(4)).map((e) => e.id)).toEqual(["in2", "tool2"]);
  });

  it("drops a reply emitted after its turn was stored", () => {
    // The reply's timestamp is later than the stored rows; its turn is still over.
    const events = [inbound("in1", 1), reply("r1-late", 9)];
    expect(currentTurn(events, [ms(0.9)], ms(8))).toEqual([]);
  });

  it("falls back to timestamps when no incoming message was seen", () => {
    const events = [reply("old", 3), reply("new", 12)];
    expect(currentTurn(events, [], ms(10)).map((e) => e.id)).toEqual(["new"]);
  });
});
