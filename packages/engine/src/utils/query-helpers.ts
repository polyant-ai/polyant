// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";

// ── Shared query helpers ────────────────────────────────────────────
// Extracted from analytics.store and latency.store to eliminate duplication.

export interface DateRange {
  from: Date;
  to: Date;
}

/** The window of the same length that ends where `range` starts, for trend comparisons. */
export function previousRange(range: DateRange): DateRange {
  const durationMs = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - durationMs), to: new Date(range.from.getTime()) };
}

/** Convert Date to ISO string for postgres driver (which rejects Date objects in raw sql) */
export function toISO(d: Date): string {
  return d.toISOString();
}

/** Cast raw execute() result to a typed array */
export function asRows<T>(result: unknown): T[] {
  return result as T[];
}

/**
 * Percentage change between two values, or `null` when the previous value is 0:
 * there is nothing to compare against, and the old "+100%" for any growth from
 * nothing read as a measured doubling.
 */
export function pctChange(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

/**
 * Allowlist of column expressions accepted by instanceFilter().
 * Only literals that appear in the actual query callers are permitted;
 * any other value throws to prevent SQL injection via sql.raw().
 */
const ALLOWED_INSTANCE_COLUMNS = new Set([
  "instance_id",
  "c.instance_id",
]);

/**
 * Build an optional `AND <column> = <value>` SQL fragment.
 * @param instanceId - when undefined the fragment is empty (no filter)
 * @param columnName - defaults to `"instance_id"`
 */
export function instanceFilter(instanceId?: string, columnName = "instance_id") {
  if (!ALLOWED_INSTANCE_COLUMNS.has(columnName)) {
    throw new Error(`instanceFilter: column "${columnName}" is not in the allowlist`);
  }
  return instanceId ? sql`AND ${sql.raw(columnName)} = ${instanceId}` : sql``;
}
