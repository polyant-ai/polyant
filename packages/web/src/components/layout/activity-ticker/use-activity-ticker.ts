// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef, useState } from "react";
import { useActivityStreamContext } from "@/lib/activity-stream/provider";
import { stepId } from "@/lib/activity-stream/merge";
import type { FeedEvent } from "@/lib/activity-stream/types";

/** How long each event stays on screen before being replaced. */
export const DWELL_MS = 4000;
/** Max events waiting after `current`. Oldest is dropped on overflow. */
export const MICRO_QUEUE_CAP = 3;
/**
 * Events older than this (now − ev.ts) are silently dropped — both on entry
 * and at queue drain. Prevents the ticker from "replaying" events accumulated
 * while the user was on another page / tab / form: the ticker is an ambient
 * live indicator, the full history lives on `/activity`.
 */
export const STALE_AGE_MS = 8000;

function isStale(ev: FeedEvent): boolean {
  const ts = Date.parse(ev.ts);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts > STALE_AGE_MS;
}

interface UseActivityTickerResult {
  current: FeedEvent | null;
}

export function useActivityTicker(): UseActivityTickerResult {
  const { subscribe } = useActivityStreamContext();
  const [current, setCurrent] = useState<FeedEvent | null>(null);
  const queueRef = useRef<FeedEvent[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRef = useRef<FeedEvent | null>(null);
  currentRef.current = current;

  useEffect(() => {
    function startDwell() {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const queue = queueRef.current;
        // Drop stale events at drain time — by now the user has waited
        // DWELL_MS for the previous event, anything older than STALE_AGE_MS
        // is no longer "live".
        while (queue.length > 0 && isStale(queue[0])) {
          queue.shift();
        }
        if (queue.length > 0) {
          const next = queue.shift()!;
          setCurrent(next);
          currentRef.current = next;
          startDwell();
        } else {
          setCurrent(null);
          currentRef.current = null;
        }
      }, DWELL_MS);
    }

    const unsub = subscribe((ev) => {
      // Drop stale events on arrival — defensive: shouldn't happen given the
      // server is fire-and-forget, but covers network buffering and clock skew.
      if (isStale(ev)) return;

      const incomingStep = stepId(ev.id);

      // Same step as the event currently on screen → in-place update,
      // do NOT restart the timer.
      if (currentRef.current && stepId(currentRef.current.id) === incomingStep) {
        setCurrent(ev);
        currentRef.current = ev;
        return;
      }

      // Same step as a queued event → replace, do NOT append.
      const queue = queueRef.current;
      const dupIdx = queue.findIndex((q) => stepId(q.id) === incomingStep);
      if (dupIdx !== -1) {
        queue[dupIdx] = ev;
        return;
      }

      // Nothing on screen → show immediately and start dwell.
      if (currentRef.current === null) {
        setCurrent(ev);
        currentRef.current = ev;
        startDwell();
        return;
      }

      // Otherwise queue it (drop oldest if full).
      queue.push(ev);
      if (queue.length > MICRO_QUEUE_CAP) {
        queue.shift();
      }
    });

    return () => {
      unsub();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [subscribe]);

  return { current };
}
