// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";

// ── Shared query helpers ────────────────────────────────────────────
// Extracted from analytics.store and latency.store to eliminate duplication.

export interface DateRange {
  from: Date;
  to: Date;
}

/** Convert Date to ISO string for postgres driver (which rejects Date objects in raw sql) */
export function toISO(d: Date): string {
  return d.toISOString();
}

/** Cast raw execute() result to a typed array */
export function asRows<T>(result: unknown): T[] {
  return result as T[];
}

/** Percentage change between two values; returns 100 when previous is 0 and current > 0 */
export function pctChange(current: number, previous: number): number {
  return previous === 0 ? (current > 0 ? 100 : 0) : ((current - previous) / previous) * 100;
}

/**
 * Allowlist of column expressions accepted by instanceFilter().
 * Only literals that appear in the actual query callers are permitted;
 * any other value throws to prevent SQL injection via sql.raw().
 */
const ALLOWED_INSTANCE_COLUMNS = new Set([
  "agent_id",
  "c.agent_id",
]);

/**
 * Build an optional `AND <column> = <value>` SQL fragment.
 * @param instanceId - when undefined the fragment is empty (no filter)
 * @param columnName - defaults to `"agent_id"`
 */
export function instanceFilter(instanceId?: string, columnName = "agent_id") {
  if (!ALLOWED_INSTANCE_COLUMNS.has(columnName)) {
    throw new Error(`instanceFilter: column "${columnName}" is not in the allowlist`);
  }
  return instanceId ? sql`AND ${sql.raw(columnName)} = ${instanceId}` : sql``;
}
