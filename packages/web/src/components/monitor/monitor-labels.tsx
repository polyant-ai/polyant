// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import type { MonitorOutcome } from "@/lib/api-types";

/**
 * The types and groups the engine knows today. The engine's lists are open: a build
 * registers more (`registerMonitorLabels`), and a type or group nobody labelled is
 * shown under its own name instead of being hidden.
 */
const TYPE_SHORT: Record<string, TranslationKey> = {
  tool_call: "monitor.type.tool_call",
  hook: "monitor.type.hook",
  webhook: "monitor.type.webhook",
  scheduled_run: "monitor.type.scheduled_run",
};

const TYPE_LONG: Record<string, TranslationKey> = {
  tool_call: "monitor.typeLong.tool_call",
  hook: "monitor.typeLong.hook",
  webhook: "monitor.typeLong.webhook",
  scheduled_run: "monitor.typeLong.scheduled_run",
};

const GROUPS: Record<string, TranslationKey> = {
  agents: "monitor.group.agents",
  automations: "monitor.group.automations",
};

const SECTIONS: Record<string, TranslationKey> = {
  arguments: "monitor.section.arguments",
  output: "monitor.section.output",
  toolCalls: "monitor.section.toolCalls",
  trigger: "monitor.section.trigger",
  channel: "monitor.section.channel",
  messageCount: "monitor.section.messageCount",
};

/** Rows of these types go when their conversation does; every other type has no expiry of its own. */
const KEPT_WITH_CONVERSATION = new Set(["webhook"]);

export interface MonitorLabelSet {
  /** The pill and the filter, by type. */
  typeShort?: Record<string, TranslationKey>;
  /** The drawer subtitle, by type. */
  typeLong?: Record<string, TranslationKey>;
  groups?: Record<string, TranslationKey>;
  /** The labelled blocks of the drawer, by section key. */
  sections?: Record<string, TranslationKey>;
  /** Types whose rows are kept as long as their conversation. */
  keptWithConversation?: readonly string[];
}

/** Add the labels of the types, groups and sections a build registers with the engine. */
export function registerMonitorLabels(set: MonitorLabelSet): void {
  Object.assign(TYPE_SHORT, set.typeShort);
  Object.assign(TYPE_LONG, set.typeLong);
  Object.assign(GROUPS, set.groups);
  Object.assign(SECTIONS, set.sections);
  for (const type of set.keptWithConversation ?? []) KEPT_WITH_CONVERSATION.add(type);
}

export function isKeptWithConversation(type: string): boolean {
  return KEPT_WITH_CONVERSATION.has(type);
}

export function useMonitorLabels() {
  const { t } = useI18n();
  return {
    typeShort: (type: string) => (TYPE_SHORT[type] ? t(TYPE_SHORT[type]) : type),
    typeLong: (type: string) => (TYPE_LONG[type] ? t(TYPE_LONG[type]) : type),
    group: (group: string) => (GROUPS[group] ? t(GROUPS[group]) : group),
    section: (key: string) => (SECTIONS[key] ? t(SECTIONS[key]) : key),
  };
}

export function TypePill({ type }: { type: string }) {
  const labels = useMonitorLabels();
  return <Badge variant="secondary">{labels.typeShort(type)}</Badge>;
}

export function OutcomePill({ outcome }: { outcome: MonitorOutcome | string }) {
  const { t } = useI18n();
  switch (outcome) {
    case "ok":
      return <StatusBadge tone="positive">{t("monitor.outcome.ok")}</StatusBadge>;
    case "error":
      return <StatusBadge tone="negative">{t("monitor.outcome.error")}</StatusBadge>;
    case "blocked":
      return <StatusBadge tone="neutral">{t("monitor.outcome.blocked")}</StatusBadge>;
    case "running":
      return <StatusBadge tone="neutral">{t("monitor.outcome.running")}</StatusBadge>;
    default:
      return <StatusBadge tone="neutral">{outcome}</StatusBadge>;
  }
}
