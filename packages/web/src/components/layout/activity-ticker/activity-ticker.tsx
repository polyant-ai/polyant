// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { TickerRow } from "./ticker-row";
import { useActivityTicker } from "./use-activity-ticker";

export function ActivityTicker() {
  const { current } = useActivityTicker();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="bg-muted/40 relative h-8 w-full max-w-2xl overflow-hidden rounded-full border"
      style={{ boxShadow: "0 0 18px -8px rgba(200,242,62,0.4)" }}
    >
      <div
        aria-hidden
        className="animate-shimmer pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, rgba(200,242,62,0.12) 50%, transparent 100%)",
          backgroundSize: "200% 100%",
        }}
      />
      {current && (
        <div key={current.id} className="absolute inset-0">
          <div
            aria-hidden
            className="animate-ticker-flash pointer-events-none absolute inset-0 rounded-full"
          />
          <div className="animate-ticker-bounce-in absolute inset-0 px-3">
            <TickerRow ev={current} />
          </div>
        </div>
      )}
    </div>
  );
}
