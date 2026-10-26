// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PermissionKey } from "../authz/permissions.js";
import type { TenantScope } from "../authz/scope-filter.js";
import { resolveInstanceMeta } from "../instances/instance-meta.js";
import { findMonitorSource, listMonitorSources } from "./monitor.registry.js";
import { DEFAULT_MONITOR_LEVEL } from "./monitor.types.js";
import type {
  MonitorCursor,
  MonitorDetail,
  MonitorItem,
  MonitorLevel,
  MonitorOutcome,
  MonitorSource,
} from "./monitor.types.js";

export const MONITOR_DEFAULT_LIMIT = 50;
export const MONITOR_MAX_LIMIT = 100;

/** Whether the caller holds a permission in the scope being read. Decided by the controller. */
export type CanRead = (permission: PermissionKey) => Promise<boolean>;

export interface MonitorReadRequest {
  scope: TenantScope;
  /** Which Monitor is read. Defaults to {@link DEFAULT_MONITOR_LEVEL}. */
  level?: MonitorLevel;
  canRead: CanRead;
  /** Only these types. Empty or absent means every type the caller can read. */
  types?: readonly string[];
  /** Only the types under this group (a chip of the panel). Combined with `types`, both must match. */
  group?: string;
  agent?: string;
  outcome?: MonitorOutcome;
  from?: Date;
  to?: Date;
  search?: string;
  cursor?: MonitorCursor;
  limit?: number;
  /** Days telemetry rows are kept, from the platform setting. */
  telemetryRetentionDays: number;
}

export interface MonitorTypeInfo {
  type: string;
  group: string;
  retentionDays: number | null;
}

export interface MonitorPage {
  items: MonitorItem[];
  /** Pass back as `cursor` for the next page; `null` on the last one. */
  nextCursor: string | null;
  /** The types this caller can read: a type absent here is hidden from them, not empty. */
  types: MonitorTypeInfo[];
}

/** (time, id) newest first. `time` is fixed width, so text order is time order. */
function newestFirst(a: MonitorItem, b: MonitorItem): number {
  if (a.time !== b.time) return a.time < b.time ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

export function encodeCursor(cursor: MonitorCursor): string {
  return Buffer.from(JSON.stringify([cursor.time, cursor.id]), "utf8").toString("base64url");
}

/** `undefined` for anything that is not a cursor this module wrote; the caller answers 400. */
export function decodeCursor(raw: string): MonitorCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [time, id] = parsed;
    if (typeof time !== "string" || typeof id !== "string") return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(time)) return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
    return { time, id };
  } catch {
    return undefined;
  }
}

/** The permission that guards a source at a level: its own, unless it names another for that level. */
function permissionFor(source: MonitorSource, level: MonitorLevel): PermissionKey {
  return source.permissionAt?.[level] ?? source.permission;
}

/** The sources that appear at a level and that the caller can read there. */
async function readableSources(canRead: CanRead, level: MonitorLevel): Promise<MonitorSource[]> {
  const all = listMonitorSources().filter((s) => (s.levels ?? [DEFAULT_MONITOR_LEVEL]).includes(level));
  const flags = await Promise.all(all.map((s) => canRead(permissionFor(s, level))));
  return all.filter((_, i) => flags[i]);
}

/** Agent names for the slugs on one page, resolved once each. An unknown slug keeps its slug as the name. */
async function nameAgents(items: MonitorItem[]): Promise<MonitorItem[]> {
  // A row about no agent carries an empty slug.
  const slugs = [...new Set(items.map((i) => i.agent.slug).filter(Boolean))];
  const names = new Map(
    await Promise.all(slugs.map(async (slug) => [slug, (await resolveInstanceMeta(slug))?.name ?? slug] as const)),
  );
  return items.map((i) => ({ ...i, agent: { slug: i.agent.slug, name: names.get(i.agent.slug) ?? i.agent.slug } }));
}

/**
 * One page of the timeline.
 *
 * Every source returns its newest `limit + 1` rows older than the cursor; the merge keeps
 * the newest `limit`. A row a source did not return is older than that source's last
 * returned row, so it cannot belong on this page, and the (time, id) cursor resumes
 * exactly where the page stopped even when several rows share a time.
 */
export async function readMonitor(req: MonitorReadRequest): Promise<MonitorPage> {
  const limit = Math.min(Math.max(req.limit ?? MONITOR_DEFAULT_LIMIT, 1), MONITOR_MAX_LIMIT);
  const level = req.level ?? DEFAULT_MONITOR_LEVEL;
  const readable = await readableSources(req.canRead, level);
  const types = readable.map((s) => ({
    type: s.type,
    group: s.group,
    retentionDays: s.retentionDays(req.telemetryRetentionDays),
  }));

  const wanted = req.types && req.types.length > 0 ? new Set(req.types) : undefined;
  const selected = readable.filter((s) => (!wanted || wanted.has(s.type)) && (!req.group || s.group === req.group));

  const lists = await Promise.all(
    selected.map((s) =>
      s.list({
        scope: req.scope,
        level,
        agent: req.agent,
        outcome: req.outcome,
        from: req.from,
        to: req.to,
        search: req.search,
        before: req.cursor,
        limit: limit + 1,
      }),
    ),
  );

  const merged = lists.flat().sort(newestFirst);
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = merged.length > limit && last ? encodeCursor({ time: last.time, id: last.id }) : null;

  return { items: await nameAgents(page), nextCursor, types };
}

/** One item with its payload, or `null` when the type is unknown, unreadable by the caller, or the row is out of scope. */
export async function readMonitorDetail(
  type: string,
  id: string,
  scope: TenantScope,
  canRead: CanRead,
  level: MonitorLevel = DEFAULT_MONITOR_LEVEL,
): Promise<MonitorDetail | null> {
  const source = findMonitorSource(type);
  if (!source || !(source.levels ?? [DEFAULT_MONITOR_LEVEL]).includes(level)) return null;
  if (!(await canRead(permissionFor(source, level)))) return null;
  const detail = await source.detail(id, scope, level);
  if (!detail) return null;
  const [named] = await nameAgents([detail]);
  return { ...detail, agent: named?.agent ?? detail.agent };
}
