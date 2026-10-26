// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FeedEvent } from "@/lib/activity-stream/types";
import type { MonitorDetail, MonitorItem, MonitorOutcome } from "@/lib/api-types";

/**
 * The Monitor lists rows read from the database and, on top, the events the server
 * is publishing right now. A live event has no database id, so it is shown as a
 * provisional row until the stored row it corresponds to is read.
 */

/** A row built from a live event: it carries the event's own previews for the drawer. */
export interface LiveMonitorItem extends MonitorItem {
  live: true;
  detail: MonitorDetail;
}

export type AnyMonitorItem = MonitorItem | LiveMonitorItem;

export function isLive(item: AnyMonitorItem): item is LiveMonitorItem {
  return (item as LiveMonitorItem).live === true;
}

/** `type:id` is unique across types; it is the React key and the dedupe key. */
export function itemKey(item: MonitorItem): string {
  return `${item.type}:${item.id}`;
}

/** How far apart a live event and its stored row may be, in ms. A stored tool call lands up to a flush interval later. */
const MATCH_WINDOW_MS = 20_000;

/**
 * What a build says about an event the Monitor has no type for out of the box: the
 * row's type, group, outcome and line, and the facts the line is worded from.
 */
export interface LiveEventRow {
  type: string;
  group: string;
  outcome: MonitorOutcome;
  summary: string;
  facts?: Record<string, string>;
  /** The row's id, when it is not the event's own. */
  id?: string;
  /** The event is about no agent: the row carries an empty one and the event needs no instance. */
  noAgent?: boolean;
}

const eventRows = new Map<string, (ev: FeedEvent) => LiveEventRow | null>();
const matchers = new Map<string, (stored: MonitorItem, live: MonitorItem, windowMs: number) => boolean>();

/** Turn the events of a category (`FeedEvent.category`) into rows, or `null` for one to leave out. */
export function registerLiveEvent(category: string, build: (ev: FeedEvent) => LiveEventRow | null): void {
  eventRows.set(category, build);
}

/**
 * Say when a stored row of a type is the one a live row announced, for a type whose rows
 * cannot be matched by conversation and time alone. Called after the ids were found different.
 */
export function registerLiveMatch(
  type: string,
  same: (stored: MonitorItem, live: MonitorItem, windowMs: number) => boolean,
): void {
  matchers.set(type, same);
}

function toolName(summary: string): string {
  const cut = summary.indexOf(":");
  return cut === -1 ? summary : summary.slice(0, cut);
}

/**
 * The live row for an event, or `null` for an event the Monitor has no type for
 * (replies, reasoning, memory) and for a tool call that has not ended yet.
 */
export function liveItemFromEvent(ev: FeedEvent): LiveMonitorItem | null {
  const build = ev.category ? eventRows.get(ev.category) : undefined;
  const registered = build?.(ev) ?? null;
  const slug = ev.instance?.slug;
  if (!slug && !registered?.noAgent) return null;
  const agent = slug ? { slug, name: ev.instance?.name ?? slug } : { slug: "", name: "" };

  let type: string;
  let group: string;
  let outcome: MonitorOutcome;
  let id = ev.id;
  let summary: string;

  if (registered) {
    ({ type, group, outcome, summary } = registered);
    id = registered.id ?? ev.id;
  } else if (ev.category === "cron") {
    type = "scheduled_run";
    group = "automations";
    outcome = "running";
    id = ev.cron?.runId ?? ev.id;
    summary = ev.cron?.name ?? ev.text;
  } else if (ev.category === "webhook") {
    type = "webhook";
    group = "automations";
    outcome = "ok";
    summary = ev.webhook ? `${ev.webhook.source} → ${ev.webhook.definition}` : ev.text;
  } else if (ev.tool && ev.status) {
    type = "tool_call";
    group = "agents";
    outcome = ev.status === "error" ? "error" : "ok";
    summary = ev.tool.summary ? `${ev.tool.name}: ${ev.tool.summary}` : ev.tool.name;
  } else {
    return null;
  }

  const item: MonitorItem = {
    id,
    type,
    group,
    time: ev.ts,
    agent,
    conversationId: ev.conversationId ?? null,
    summary,
    outcome,
    durationMs: ev.durationMs ?? null,
    ...(registered?.facts ? { facts: registered.facts } : {}),
  };
  const sections: MonitorDetail["sections"] = [];
  if (ev.argsPreview) sections.push({ key: "arguments", kind: "text", value: ev.argsPreview });
  const output = ev.resultPreview ?? ev.responsePreview;
  if (output) sections.push({ key: "output", kind: "text", value: output });
  return {
    ...item,
    live: true,
    detail: { ...item, error: ev.status === "error" ? (ev.resultPreview ?? null) : null, sections },
  };
}

/** Whether a stored row is the one a live row announced. */
function sameEvent(stored: MonitorItem, live: MonitorItem): boolean {
  if (stored.type !== live.type || stored.agent.slug !== live.agent.slug) return false;
  if (stored.id === live.id) return true;
  if (stored.type === "scheduled_run") return false;
  const custom = matchers.get(stored.type);
  if (custom) return custom(stored, live, MATCH_WINDOW_MS);
  if ((stored.conversationId ?? null) !== (live.conversationId ?? null)) return false;
  if (stored.type === "tool_call" && toolName(stored.summary) !== toolName(live.summary)) return false;
  return Math.abs(Date.parse(stored.time) - Date.parse(live.time)) <= MATCH_WINDOW_MS;
}

/** The filters the page holds, applied to a live row the way the engine applies them to a stored one. */
export interface LiveFilter {
  group?: string;
  types?: readonly string[];
  agent?: string;
  outcome?: MonitorOutcome;
  /** A search cannot be answered from a preview, so a live row never matches one. */
  q?: string;
  /** Types the caller may read, when known. */
  readable?: readonly string[];
}

export function liveMatches(item: MonitorItem, f: LiveFilter): boolean {
  if (f.q) return false;
  if (f.readable && !f.readable.includes(item.type)) return false;
  if (f.group && item.group !== f.group) return false;
  if (f.types && f.types.length > 0 && !f.types.includes(item.type)) return false;
  if (f.agent && item.agent.slug !== f.agent) return false;
  if (f.outcome && item.outcome !== f.outcome) return false;
  return true;
}

function newestFirst(a: MonitorItem, b: MonitorItem): number {
  const ta = Date.parse(a.time);
  const tb = Date.parse(b.time);
  if (ta !== tb) return tb - ta;
  // Same millisecond: stored rows keep their microseconds, which settle the order.
  if (a.time !== b.time) return a.time < b.time ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Stored rows plus the live rows no stored row accounts for, newest first.
 * A live row older than the oldest stored row is dropped: it would sit past the
 * point the user has paged to and could not be told from a missing stored row.
 */
export function withLive(stored: readonly MonitorItem[], live: readonly LiveMonitorItem[]): AnyMonitorItem[] {
  const oldest = stored.length > 0 ? Date.parse(stored[stored.length - 1]!.time) : -Infinity;
  const extra = live.filter((l) => Date.parse(l.time) >= oldest && !stored.some((s) => sameEvent(s, l)));
  return [...stored, ...extra].sort(newestFirst);
}

/** A freshly read first page folded into the rows already held, without repeats. */
export function foldFresh(held: readonly MonitorItem[], fresh: readonly MonitorItem[]): MonitorItem[] {
  const byKey = new Map<string, MonitorItem>();
  for (const item of held) byKey.set(itemKey(item), item);
  for (const item of fresh) byKey.set(itemKey(item), item);
  return [...byKey.values()].sort(newestFirst);
}
