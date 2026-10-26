// SPDX-License-Identifier: AGPL-3.0-or-later

import { api, type MonitorDetail, type MonitorItem, type MonitorPage } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n/types";
import type { TenantPaths } from "@/lib/tenant/use-tenant-paths";

/**
 * Where a build plugs its own parts into the Monitor without editing the shared
 * components: another view of the stream, the wording of a type's line, where a
 * conversation opens. Each registration is keyed, so registering the same key twice
 * replaces the first, and a module that registers can be imported more than once.
 */

/** A name for one view of the Monitor. A build with a single view only uses {@link DEFAULT_MONITOR_LEVEL}. */
export type MonitorLevel = string;

export const DEFAULT_MONITOR_LEVEL: MonitorLevel = "workspace";

/** What the Monitor list accepts. */
export type MonitorListParams = NonNullable<Parameters<typeof api.monitor.list>[0]>;

/** Where one view reads from. `key` tells two sources of the same level apart (the list is another one when it changes). */
export interface MonitorEndpoint {
  key: string;
  list: (params: MonitorListParams) => Promise<MonitorPage>;
  detail: (type: string, id: string) => Promise<MonitorDetail>;
}

export interface MonitorLevelView {
  /**
   * The endpoint to read, or `null` while it cannot be resolved yet (the Monitor then
   * waits instead of asking for nobody's data). A hook, so a level can read the route.
   * The level of a mounted Monitor does not change, so the hook count stays the same.
   */
  useEndpoint: () => MonitorEndpoint | null;
  /** The chips shown before the engine has said which types the caller may read. */
  defaultGroups: readonly string[];
  /** Whether the agent filter is offered: only where one list of agents is the thing being read. */
  agentFilter: boolean;
  /** Whether a row's conversation can be opened from here. */
  conversationLinks: boolean;
}

const workspaceEndpoint: MonitorEndpoint = {
  key: DEFAULT_MONITOR_LEVEL,
  list: (params) => api.monitor.list(params),
  detail: (type, id) => api.monitor.detail(type, id),
};

const levels = new Map<MonitorLevel, MonitorLevelView>([
  [
    DEFAULT_MONITOR_LEVEL,
    { useEndpoint: () => workspaceEndpoint, defaultGroups: ["agents", "automations"], agentFilter: true, conversationLinks: true },
  ],
]);

export function registerMonitorLevel(level: MonitorLevel, view: MonitorLevelView): void {
  levels.set(level, view);
}

export function monitorLevelView(level: MonitorLevel): MonitorLevelView {
  return levels.get(level) ?? levels.get(DEFAULT_MONITOR_LEVEL)!;
}

export function useMonitorEndpoint(level: MonitorLevel): MonitorEndpoint | null {
  return monitorLevelView(level).useEndpoint();
}

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/** The page's own currency formatter, so an amount reads the same here as on every other page. */
export type Money = (value: number) => string;

/** The line of an item worded from its facts, or `undefined` to keep the summary the engine wrote. */
export type MonitorSummary = (item: MonitorItem, t: Translate, money: Money) => string | undefined;

const summaries = new Map<string, MonitorSummary>();

export function registerMonitorSummary(type: string, compose: MonitorSummary): void {
  summaries.set(type, compose);
}

/**
 * The line an item shows in the list, in the reader's language. An item with no facts,
 * or of a type nobody words, keeps the summary the engine wrote.
 */
export function itemSummary(item: MonitorItem, t: Translate, money: Money): string {
  if (!item.facts) return item.summary;
  return summaries.get(item.type)?.(item, t, money) ?? item.summary;
}

export type ConversationHref = (conversationId: string, paths: TenantPaths) => string;

let conversationHref: ConversationHref = (conversationId, paths) =>
  paths.workspace(`/conversations?id=${encodeURIComponent(conversationId)}`);

/** Where a conversation opens, when this build opens it somewhere else. */
export function registerMonitorConversationHref(href: ConversationHref): void {
  conversationHref = href;
}

export function monitorConversationHref(conversationId: string, paths: TenantPaths): string {
  return conversationHref(conversationId, paths);
}
