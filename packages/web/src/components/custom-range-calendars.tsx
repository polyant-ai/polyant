// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { toIsoDay } from "@/lib/format";

/**
 * The custom half of a period picker: a "from" and a "to" calendar and the button
 * that applies them. A day in the future is not selectable, and "to" cannot
 * precede "from". `onApply` receives inclusive `"YYYY-MM-DD"` days.
 *
 * Shared by the analytics range picker and the table's period filter, which
 * differ only in their presets and in whether each calendar carries a caption.
 */
export function CustomRangeCalendars({
  applyLabel,
  onApply,
  captions,
}: {
  applyLabel: string;
  onApply: (range: { from: string; to: string }) => void;
  /** A caption above each calendar; omit when the surrounding heading already says it. */
  captions?: { from: string; to: string };
}) {
  const [calFrom, setCalFrom] = useState<Date | undefined>();
  const [calTo, setCalTo] = useState<Date | undefined>();

  return (
    <>
      <div className="flex gap-4">
        <div>
          {captions && <p className="mb-2 text-xs font-medium text-muted-foreground">{captions.from}</p>}
          <Calendar mode="single" selected={calFrom} onSelect={setCalFrom} disabled={(date) => date > new Date()} />
        </div>
        <div>
          {captions && <p className="mb-2 text-xs font-medium text-muted-foreground">{captions.to}</p>}
          <Calendar
            mode="single"
            selected={calTo}
            onSelect={setCalTo}
            disabled={(date) => date > new Date() || (calFrom ? date < calFrom : false)}
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          disabled={!calFrom || !calTo}
          onClick={() => {
            if (calFrom && calTo) onApply({ from: toIsoDay(calFrom), to: toIsoDay(calTo) });
          }}
        >
          {applyLabel}
        </Button>
      </div>
    </>
  );
}
