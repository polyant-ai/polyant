// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef } from "react";

/**
 * Ask again every `intervalMs` while `active`, for work the engine finishes on
 * its own (a document being processed).
 *
 * A step is skipped while the browser tab is hidden: nobody is looking, and the
 * time does not count toward `maxAttempts`. After `maxAttempts` steps in view the
 * polling stops and `onGiveUp` runs once; it starts again from zero the next time
 * `active` turns on.
 */
export function usePolling(
  active: boolean,
  poll: () => void,
  { intervalMs, maxAttempts, onGiveUp }: { intervalMs: number; maxAttempts: number; onGiveUp: () => void },
): void {
  const attempts = useRef(0);
  const callbacks = useRef({ poll, onGiveUp });
  useEffect(() => {
    callbacks.current = { poll, onGiveUp };
  });

  useEffect(() => {
    if (!active) {
      attempts.current = 0;
      return;
    }
    if (attempts.current >= maxAttempts) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      attempts.current += 1;
      if (attempts.current >= maxAttempts) {
        clearInterval(interval);
        callbacks.current.onGiveUp();
        return;
      }
      callbacks.current.poll();
    }, intervalMs);
    return () => clearInterval(interval);
  }, [active, intervalMs, maxAttempts]);
}
