// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { mergeEvent } from "./merge";
import { isNoiseEvent } from "./noise-filter";
import type { FeedEvent } from "./types";

const MAX_BUFFERED_EVENTS = 500;
const STREAM_URL = "/api/activity-stream/live";

type Subscriber = (ev: FeedEvent) => void;

interface ActivityStreamContextValue {
  events: FeedEvent[];
  realLive: boolean;
  error: string | null;
  subscribe: (cb: Subscriber) => () => void;
}

const ActivityStreamContext = createContext<ActivityStreamContextValue | null>(null);

export function ActivityStreamProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [realLive, setRealLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subscribersRef = useRef<Set<Subscriber>>(new Set());

  const subscribe = useCallback((cb: Subscriber) => {
    subscribersRef.current.add(cb);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  useEffect(() => {
    const source = new EventSource(STREAM_URL);

    source.onopen = () => {
      setRealLive(true);
      setError(null);
    };

    source.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as FeedEvent;
        if (isNoiseEvent(evt)) return;
        setEvents((prev) => mergeEvent(prev, evt, MAX_BUFFERED_EVENTS));
        for (const cb of subscribersRef.current) {
          try {
            cb(evt);
          } catch {
            // A misbehaving subscriber must never break the stream.
          }
        }
      } catch {
        // Ignore malformed messages.
      }
    };

    source.onerror = () => {
      setRealLive(false);
      setError("connection lost");
    };

    return () => {
      source.close();
    };
  }, []);

  const value = useMemo<ActivityStreamContextValue>(
    () => ({ events, realLive, error, subscribe }),
    [events, realLive, error, subscribe],
  );

  return (
    <ActivityStreamContext.Provider value={value}>
      {children}
    </ActivityStreamContext.Provider>
  );
}

export function useActivityStreamContext(): ActivityStreamContextValue {
  const ctx = useContext(ActivityStreamContext);
  if (!ctx) {
    throw new Error(
      "useActivityStreamContext must be used inside <ActivityStreamProvider>",
    );
  }
  return ctx;
}
