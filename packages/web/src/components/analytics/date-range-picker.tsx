// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CustomRangeCalendars } from "@/components/custom-range-calendars";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { lastDays } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export interface DateRange {
  from: string;
  to: string;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const presets = [
    { label: t("analytics.dateRange.7d"), days: 7 },
    { label: t("analytics.dateRange.30d"), days: 30 },
    { label: t("analytics.dateRange.90d"), days: 90 },
  ];

  const activeDays = Math.round(
    (new Date(value.to).getTime() - new Date(value.from).getTime()) /
      (1000 * 60 * 60 * 24),
  );

  const applyPreset = (days: number) => onChange(lastDays(days));

  return (
    <div className="flex items-center gap-2">
      {presets.map((p) => (
        <Button
          key={p.days}
          variant={activeDays === p.days ? "default" : "outline"}
          size="sm"
          onClick={() => applyPreset(p.days)}
        >
          {p.label}
        </Button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <CalendarIcon className="h-3.5 w-3.5" />
            {t("analytics.dateRange.custom")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-4" align="end">
          <CustomRangeCalendars
            applyLabel={t("analytics.dateRange.apply")}
            captions={{ from: t("analytics.dateRange.from"), to: t("analytics.dateRange.to") }}
            onApply={(range) => {
              onChange(range);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
