// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The value Radix needs for the "no filter" row: an item cannot carry an empty string. */
const ALL = "_all";

/**
 * A filter dropdown whose first row clears it. The caller's value is `""` for
 * "no filter", and this maps that to and from the sentinel Radix requires, so
 * no list view spells `value || "_all"` and `v === "_all" ? "" : v` by hand.
 */
export function OptionalSelect({
  value,
  onChange,
  allLabel,
  options,
  className = "w-[200px]",
}: {
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: readonly { value: string; label: string }[];
  /** Width (or any class) of the trigger. */
  className?: string;
}) {
  return (
    <Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? "" : next)}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
