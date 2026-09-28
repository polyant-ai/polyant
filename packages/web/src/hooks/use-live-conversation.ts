// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { eventKind, type FeedEvent } from "@/lib/activity-stream/types";
import { mergeEvent } from "@/lib/activity-stream/merge";

/** Events kept per page; a turn emits a handful, so this spans many turns. */
const MAX_EVENTS = 100;
/** A turn stores several rows back to back; one re-read covers them all. */
const PERSISTED_DEBOUNCE_MS = 200;

/**
 * How far after its stored user row an incoming-message event can be emitted.
 * The row is stamped at arrival and the event follows one conversation upsert
 * later, both on the engine's clock.
 */
const INBOUND_EMIT_WINDOW_MS = 5_000;

/**
 * The events of the turn still running, given the stored transcript.
 *
 * A turn starts with its incoming message, and its rows are stored together at
 * its end, so the turn is over once a stored user row matches the latest
 * incoming-message event. Arrival order decides what belongs to the turn, not
 * timestamps: the engine can emit a turn's reply after the reply is stored.
 * Without an incoming-message event (a channel that emits none, or a turn older
 * than the socket's replay), events newer than the newest stored row are kept.
 */
export function currentTurn(events: FeedEvent[], storedUserTimes: number[], newestStored: number): FeedEvent[] {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (eventKind(events[i]) === "inbound") {
      start = i;
      break;
    }
  }
  if (start === -1) return events.filter((evt) => new Date(evt.ts).getTime() > newestStored);
  const arrived = new Date(events[start].ts).getTime();
  const stored = storedUserTimes.some((t) => t <= arrived && arrived - t <= INBOUND_EMIT_WINDOW_MS);
  return stored ? [] : events.slice(start);
}

/**
 * Follow one conversation while it happens, on whatever channel it runs.
 *
 * `events` are the activity events the engine emitted for it, in arrival order
 * (the socket replays recent ones on connect). `onPersisted` fires, debounced,
 * after rows for the conversation are stored: the caller re-reads the
 * transcript and narrows the events with `currentTurn`.
 */
export function useLiveConversation({ conversationId, instanceId, enabled, onPersisted }: {
  conversationId: string;
  instanceId: string;
  enabled: boolean;
  onPersisted: () => void;
}): { events: FeedEvent[]; connected: boolean } {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const onPersistedRef = useRef(onPersisted);
  useEffect(() => {
    onPersistedRef.current = onPersisted;
  }, [onPersisted]);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(api.conversations.liveUrl(conversationId, instanceId));
    let timer: ReturnType<typeof setTimeout> | undefined;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as FeedEvent;
        // A tool's start and end fold into one event, as in the activity panel.
        setEvents((prev) => mergeEvent(prev, evt, MAX_EVENTS));
      } catch {
        // Ignore malformed frames.
      }
    };
    source.addEventListener("persisted", () => {
      clearTimeout(timer);
      timer = setTimeout(() => onPersistedRef.current(), PERSISTED_DEBOUNCE_MS);
    });

    return () => {
      clearTimeout(timer);
      source.close();
      setConnected(false);
      setEvents([]);
    };
  }, [conversationId, instanceId, enabled]);

  return { events, connected };
}
