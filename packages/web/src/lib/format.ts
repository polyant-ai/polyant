// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TranslationKey } from "@/lib/i18n/types";

type TranslateFn = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Parse a date string as UTC. PostgreSQL timestamp columns without timezone
 * return strings like "2026-04-03T07:45:46.000" (no Z suffix). JavaScript
 * treats these as local time, causing wrong display. This helper appends "Z"
 * when no timezone indicator is present, so the browser correctly converts
 * from UTC to the user's local timezone.
 */
export function parseUTC(dateStr: string): Date {
  if (/[Z+\-]\d{0,4}:?\d{0,2}$/.test(dateStr)) return new Date(dateStr);
  return new Date(dateStr + "Z");
}

export function formatRelativeTime(
  dateStr: string | null,
  t: TranslateFn,
  locale?: string,
): string {
  if (!dateStr) return "\u2014";
  const date = parseUTC(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return t("instances.time.justNow");
  if (diffMins < 60) return t("instances.time.minutesAgo", { count: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return t("instances.time.hoursAgo", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return t("instances.time.daysAgo", { count: diffDays });
  return date.toLocaleDateString(locale);
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/**
 * Every date the panel prints goes through one of these, and each takes the UI's
 * locale.
 *
 * `undefined` as the locale \u2014 what these passed before \u2014 is the BROWSER's locale,
 * which is a different answer from the one the user picked in the language toggle.
 * An Italian panel on a US-English browser printed `7/14/2026, 11:39:09 AM` in a
 * page whose every other word was Italian, and a date range read as inverted
 * because `08/07` and `07/08` swap meaning between the two. The locale is the UI's
 * choice, so it has to be threaded in: `useFormat()` (lib/use-format.ts) binds
 * these to it, and components use that rather than calling `toLocaleString`.
 */
export function formatDate(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "\u2014";
  try {
    return parseUTC(iso).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatDateTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "\u2014";
  try {
    return parseUTC(iso).toLocaleString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Wall-clock only — for a transcript, where the day is a separator above. */
export function formatTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "\u2014";
  try {
    return parseUTC(iso).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Thousands separators in the UI's locale — 1.234 in Italian, 1,234 in English. */
export function formatNumber(value: number, locale?: string): string {
  return value.toLocaleString(locale);
}

/**
 * Shared by every analytics comparison table (instance, organization): more
 * decimal places under $1 so a sub-cent cost does not round to "$0.00".
 */
export function formatCost(value: number): string {
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Shared by every analytics comparison table - abbreviates large token counts. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
