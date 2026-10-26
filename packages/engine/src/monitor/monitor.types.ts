// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PermissionKey } from "../authz/permissions.js";
import type { TenantScope } from "../authz/scope-filter.js";

/**
 * The Monitor read model: ONE time-ordered list of what happened, assembled from the
 * tables that already record it. A row is read from its own table at request time, so the
 * Monitor adds no storage and cannot disagree with the page that owns the row.
 *
 * `type` and `group` are open strings on purpose. A build that records further things
 * (governance decisions, retention purges, budget stops) registers another
 * {@link MonitorSource} and its rows join the same list; neither the reader nor the
 * controller changes.
 */

/**
 * Where the Monitor is read from: a name for one view of the same stream of rows. A build
 * with a single view only ever uses {@link DEFAULT_MONITOR_LEVEL}; a build that adds views
 * names them and says, per source, which ones list it.
 */
export type MonitorLevel = string;

/** The view every source appears in unless it declares otherwise. */
export const DEFAULT_MONITOR_LEVEL: MonitorLevel = "workspace";

/** What became of the thing. `blocked` is for a policy refusing it; `running` is not finished yet. */
export type MonitorOutcome = "ok" | "error" | "blocked" | "running";

export const MONITOR_OUTCOMES: readonly MonitorOutcome[] = ["ok", "error", "blocked", "running"];

/** One row of the timeline. Light on purpose: payloads are read through {@link MonitorDetail}. */
export interface MonitorItem {
  /** The id of the row in its own table. Unique only together with `type`. */
  id: string;
  type: string;
  /** The chip the type sits under in the panel. */
  group: string;
  /** ISO 8601 with microseconds, exactly as stored: it is half of the pagination cursor. */
  time: string;
  agent: { slug: string; name: string };
  conversationId: string | null;
  /** One line, built from data the row holds (a tool name, a task name, a title). */
  summary: string;
  outcome: MonitorOutcome;
  durationMs: number | null;
  /**
   * Short named facts the panel can word in the reader's language, for a type whose
   * summary cannot be one sentence the engine writes (who did what to whom, which limit
   * was reached). String to string, so a panel that does not know a type still
   * renders it by its summary.
   */
  facts?: Record<string, string>;
}

/** A labelled block of the detail drawer. The panel labels it from `key`, so a new type needs no panel change. */
export interface MonitorSection {
  key: string;
  kind: "json" | "text";
  value: unknown;
}

export interface MonitorDetail extends MonitorItem {
  error: string | null;
  sections: MonitorSection[];
}

/** A page boundary: the (time, id) of the last item the previous page returned. */
export interface MonitorCursor {
  time: string;
  id: string;
}

/** What one source is asked for. Every field narrows; none widens. */
export interface MonitorSourceQuery {
  scope: TenantScope;
  /** Which Monitor is asking. A source that reads differently per level branches on it. */
  level: MonitorLevel;
  agent?: string;
  outcome?: MonitorOutcome;
  from?: Date;
  to?: Date;
  /** Free text, matched against what the source can match cheaply. */
  search?: string;
  /** Only rows strictly older than this, in (time, id) order. */
  before?: MonitorCursor;
  limit: number;
}

/**
 * A kind of record the Monitor can list.
 *
 * `permission` is the one that guards reading the same rows elsewhere; the reader skips a
 * source the caller does not hold instead of failing the whole list.
 */
export interface MonitorSource {
  type: string;
  group: string;
  permission: PermissionKey;
  /** The Monitors this type appears in. Absent means the default one only. */
  levels?: readonly MonitorLevel[];
  /** The permission to read at a level where it is not {@link permission}. */
  permissionAt?: Partial<Record<MonitorLevel, PermissionKey>>;
  /**
   * How long rows are kept, or `null` when they are kept as long as the product data they
   * belong to. Read per request because the platform setting changes at runtime.
   */
  retentionDays(telemetryRetentionDays: number): number | null;
  /** Newest first by (time, id), at most `limit` rows, agent names left as slugs. */
  list(query: MonitorSourceQuery): Promise<MonitorItem[]>;
  /** One row with its payload, or `null` when absent or outside the scope. */
  detail(id: string, scope: TenantScope, level: MonitorLevel): Promise<MonitorDetail | null>;
}
