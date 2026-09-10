// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";
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
 * The six per-agent behaviours, resolved — and the ONE place the fallback to the
 * deployment default is applied.
 *
 * They were `DATETIME_TIMEZONE`, `DATETIME_LOCALE`,
 * `DEDUP_SIMILARITY_THRESHOLD` and the three `MESSAGE_*`: one answer for the
 * whole installation, for questions two agents on it legitimately answer
 * differently. The env vars stay as the default, so an installation that sets no
 * column keeps exactly the behaviour it has.
 *
 * Resolution is a pure function of the row, deliberately. Reading the row is the
 * caller's business — the pipeline and the supervisor already have it — and a
 * resolver that fetched would put a query behind every date it formats.
 */
export function resolveDatetimeSettings(row: StoredRow): DatetimeSettings {
  return {
    timezone: row.datetimeTimezone ?? config.datetime.timezone,
    locale: row.datetimeLocale ?? config.datetime.locale,
  };
}

export function resolveDedupSimilarityThreshold(row: StoredRow): number {
  return row.dedupSimilarityThreshold ?? config.memory.dedupSimilarityThreshold;
}

export function resolveMessageTimings(row: StoredRow): MessageTimingSettings {
  return {
    softDebounceMs: row.messageSoftDebounceMs ?? config.coordinator.softDebounceMs,
    typingDelayMs: row.messageTypingDelayMs ?? config.coordinator.typingDelayMs,
    maxRestarts: row.messageMaxRestarts ?? config.coordinator.maxRestarts,
  };
}

