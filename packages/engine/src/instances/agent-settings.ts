// SPDX-License-Identifier: AGPL-3.0-or-later

import type { instances } from "./schema.js";

/** The six per-agent values as they are STORED: null means "use the default". */
type StoredRow = Pick<
  typeof instances.$inferSelect,
  | "datetimeTimezone"
  | "datetimeLocale"
  | "dedupSimilarityThreshold"
  | "messageSoftDebounceMs"
  | "messageTypingDelayMs"
  | "messageMaxRestarts"
>;

/**
 * A row with none of the six set: what an agent that has declared nothing
 * resolves to, and what a caller with no agent at all gets. Named rather than
 * inlined so "the deployment defaults" is one value with one reading.
 */
export const UNSET_AGENT_SETTINGS: StoredRow = {
  datetimeTimezone: null,
  datetimeLocale: null,
  dedupSimilarityThreshold: null,
  messageSoftDebounceMs: null,
  messageTypingDelayMs: null,
  messageMaxRestarts: null,
};

/** How an agent formats the date and time it shows. */
export interface DatetimeSettings {
  readonly timezone: string;
  readonly locale: string;
}

/** How an agent collapses a burst of inbound fragments. */
export interface MessageTimingSettings {
  readonly softDebounceMs: number;
  readonly typingDelayMs: number;
  readonly maxRestarts: number;
}

/**
 * The defaults these six fall back to, and the only place they are written.
 *
 * They used to be six environment variables (`DATETIME_TIMEZONE`,
 * `DATETIME_LOCALE`, `DEDUP_SIMILARITY_THRESHOLD`, `MESSAGE_SOFT_DEBOUNCE_MS`,
 * `MESSAGE_TYPING_DELAY_MS`, `MESSAGE_MAX_RESTARTS`) — one answer for the whole
 * installation to a question each agent now answers for itself in the panel.
 * Once the column exists, the variable is a second place the same answer can
 * come from, so it is gone and the default lives beside the resolver that
 * applies it.
 *
 * Date and time still follow the RUNTIME zone and locale (`TZ`, `LANG`/`LC_ALL`,
 * else the system's), which is Node's own behaviour rather than configuration of
 * ours: `resolvedOptions()` reads what was set before the process started.
 */
export const DEFAULT_DATETIME_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const DEFAULT_DATETIME_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;
export const DEFAULT_DEDUP_SIMILARITY_THRESHOLD = 0.90;
export const DEFAULT_MESSAGE_TIMINGS: MessageTimingSettings = {
  softDebounceMs: 2000,
  typingDelayMs: 1500,
  maxRestarts: 3,
};

/**
 * The six per-agent behaviours, resolved — and the ONE place the fallback to the
 * deployment default is applied.
 *
 * Resolution is a pure function of the row, deliberately. Reading the row is the
 * caller's business — the pipeline and the supervisor already have it — and a
 * resolver that fetched would put a query behind every date it formats.
 */
export function resolveDatetimeSettings(row: StoredRow): DatetimeSettings {
  return {
    timezone: row.datetimeTimezone ?? DEFAULT_DATETIME_TIMEZONE,
    locale: row.datetimeLocale ?? DEFAULT_DATETIME_LOCALE,
  };
}

export function resolveDedupSimilarityThreshold(row: StoredRow): number {
  return row.dedupSimilarityThreshold ?? DEFAULT_DEDUP_SIMILARITY_THRESHOLD;
}

export function resolveMessageTimings(row: StoredRow): MessageTimingSettings {
  return {
    softDebounceMs: row.messageSoftDebounceMs ?? DEFAULT_MESSAGE_TIMINGS.softDebounceMs,
    typingDelayMs: row.messageTypingDelayMs ?? DEFAULT_MESSAGE_TIMINGS.typingDelayMs,
    maxRestarts: row.messageMaxRestarts ?? DEFAULT_MESSAGE_TIMINGS.maxRestarts,
  };
}
