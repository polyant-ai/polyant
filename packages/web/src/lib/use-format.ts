// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n/context";
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  formatTime,
} from "@/lib/format";

/**
 * Dates and numbers in the locale the USER picked, not the one their browser
 * happens to send.
 *
 * The panel had a `t()` for every word and a bare `toLocaleString()` for every
 * date, so an Italian UI on a US-English browser printed `7/14/2026, 11:39:09 AM`
 * next to Italian labels, and a `Da 08/07 → A 07/08` range read as inverted
 * because those two orders mean different days in the two locales.
 *
 * One hook, so a component never reaches for `toLocaleString` again: the pure
 * formatters in `lib/format.ts` still take an explicit locale (they are called
 * from non-React code too), and this binds them to `useI18n().locale`.
 */
export function useFormat() {
  const { locale, t } = useI18n();

  return useMemo(
    () => ({
      /** 14 lug 2026 */
      date: (iso: string | null | undefined) => formatDate(iso, locale),
      /** 14 lug 2026, 11:39 */
      dateTime: (iso: string | null | undefined) => formatDateTime(iso, locale),
      /** 11:39 — for a transcript, where the day is a separator above */
      time: (iso: string | null | undefined) => formatTime(iso, locale),
      /** 1.234 */
      number: (value: number) => formatNumber(value, locale),
      /** "5 minuti fa", falling back to a date past 30 days */
      relative: (iso: string | null) => formatRelativeTime(iso, t, locale),
    }),
    [locale, t],
  );
}
