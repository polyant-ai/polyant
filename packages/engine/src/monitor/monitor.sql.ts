// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type SQL } from "drizzle-orm";
import { buildOrgScopedAgentFilterFragment } from "../authz/scope-filter.js";
import type { MonitorOutcome, MonitorSourceQuery } from "./monitor.types.js";

/**
 * SQL fragments every source shares. A source passes its own column names; they are
 * literals in the source files, never request text, so they go through `sql.identifier`.
 */

/** `to_char` shape that keeps microseconds: a cursor built from milliseconds would skip or repeat rows. */
export function timeText(column: string): SQL {
  return sql`to_char(${sql.identifier(column)} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Escape LIKE wildcards so free text is matched literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The tenant and narrowing predicates, as `AND ...` fragments.
 *
 * `outcomeSql` maps an outcome to the source's own condition, or `null` when the source
 * can never produce it (a source with no `running` state answers a `running` filter with
 * nothing, which the caller sees as an empty list rather than a different list).
 */
export function commonFilters(
  q: MonitorSourceQuery,
  cols: { time: string; id: string; agent: string },
  outcomeSql: (outcome: MonitorOutcome) => SQL | null,
): SQL {
  const time = sql.identifier(cols.time);
  const id = sql.identifier(cols.id);
  const agent = sql.identifier(cols.agent);
  const parts: SQL[] = [buildOrgScopedAgentFilterFragment(q.scope, "instance_id")];
  if (q.agent) parts.push(sql`and ${agent} = ${q.agent}`);
  if (q.outcome) {
    const condition = outcomeSql(q.outcome);
    parts.push(condition ? sql`and ${condition}` : sql`and false`);
  }
  if (q.from) parts.push(sql`and ${time} >= ${q.from.toISOString()}::timestamptz`);
  if (q.to) parts.push(sql`and ${time} <= ${q.to.toISOString()}::timestamptz`);
  if (q.before) {
    parts.push(sql`and (${time}, ${id}) < (${q.before.time}::timestamptz, ${q.before.id}::uuid)`);
  }
  return sql.join(parts, sql` `);
}
