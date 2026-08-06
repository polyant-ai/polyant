// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { stepId } from "@/lib/activity-stream/merge";
import type { FeedEvent, RowLabels } from "@/lib/activity-stream/types";
import { ActivityRow } from "./activity-row";

interface Props {
  events: FeedEvent[];
  emptyText: string;
  labels: RowLabels;
}

export function ActivityFeed({ events, emptyText, labels }: Props) {
  // Snapshot of "now" at the moment the feed mounts. Events whose timestamp
  // is older than this snapshot are part of the bus replay (history), so we
  // skip the entry animation on them — animating 100 rows on first paint
  // would be visual noise. Events that arrive after mount get the slide-in.
  const [mountSnapshot] = useState(() => Date.now());

  if (events.length === 0) {
    return (
      <div className="bg-muted/20 text-muted-foreground flex min-h-[280px] items-center justify-center rounded-md border border-dashed p-8 text-center text-sm">
        {emptyText}
      </div>
    );
  }

  // Newest first: the most recent event sits at the top of the feed.
  const sorted = events.slice().reverse();
  const newestId = sorted[0]?.id;

  return (
    <div className="bg-muted/20 max-h-[80vh] overflow-y-auto rounded-md border p-2">
      <ul className="flex flex-col gap-1.5">
        {sorted.map((ev) => (
          <ActivityRow
            // Use the stepId so React keeps the same row mounted across a
            // `:start` → `:end` transition (the event id mutates when the
            // pair merges, but the underlying step is the same).
            key={stepId(ev.id)}
            ev={ev}
            isLast={ev.id === newestId}
            isFresh={Date.parse(ev.ts) >= mountSnapshot}
            labels={labels}
          />
        ))}
      </ul>
    </div>
  );
}
