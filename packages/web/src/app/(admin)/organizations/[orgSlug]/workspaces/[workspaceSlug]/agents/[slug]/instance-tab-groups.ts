// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent detail page's THIRTEEN tabs, regrouped into five rail groups —
 * design spec `2026-07-30-admin-console-ia-redesign-design.md`, agent-detail
 * phase (§8, phase 10): "group by the question each tab answers". DATA, on
 * purpose, so the page renders this list rather than hard-coding five JSX
 * blocks — the same reason `SETTINGS_SECTIONS` (`lib/settings/sections.ts`)
 * is data and not JSX.
 *
 * `INSTANCE_TAB_VALUES` is derived from this list (not hand-duplicated) so
 * the set of valid `?tab=` values can never drift from the groups below it.
 *
 * FIVE groups for thirteen tabs, so the last two hold one tab each. Kept as five
 * rather than merged: the enterprise overlay fills them (governance and compliance
 * join Osservabilità, retention joins Dati e privacy — all three are enterprise
 * capabilities), and merging here would invent a THIRD grouping vocabulary for
 * someone to reconcile later. A heading over one row reads fine in a vertical
 * rail; what does not is a rail with only ONE group, which is why the settings
 * rail suppresses its heading in that case.
 */

import type { TranslationKey } from "@/lib/i18n/types";

/** One selectable tab: `value` drives the `?tab=` query param, `labelKey` reuses the existing `instances.detail.tab*` keys. */
export interface InstanceTabDef {
  value: string;
  labelKey: TranslationKey;
}

/** One rail group. */
export interface InstanceTabGroup {
  key: string;
  titleKey: TranslationKey;
  tabs: readonly InstanceTabDef[];
}

export const INSTANCE_TAB_GROUPS: readonly InstanceTabGroup[] = [
  {
    key: "general",
    titleKey: "instances.detail.groupGeneral",
    tabs: [
      { value: "general", labelKey: "instances.detail.tabGeneral" },
      { value: "settings", labelKey: "instances.detail.tabSettings" },
    ],
  },
  {
    key: "behavior",
    titleKey: "instances.detail.groupBehavior",
    tabs: [
      { value: "prompts", labelKey: "instances.detail.tabPrompts" },
      { value: "tools", labelKey: "instances.detail.tabTools" },
      // External MCP servers sit next to Tools on purpose: they answer the same
      // question ("what can this agent do"), just for capabilities that live
      // outside the engine — their tools reach the model as `mcp__<server>__*`.
      { value: "mcp", labelKey: "instances.detail.tabMcp" },
      { value: "skills", labelKey: "instances.detail.tabSkills" },
      { value: "knowledge", labelKey: "instances.detail.tabKnowledge" },
      { value: "hooks", labelKey: "instances.detail.tabHooks" },
    ],
  },
  {
    key: "channelsTriggers",
    titleKey: "instances.detail.groupChannelsTriggers",
    tabs: [
      { value: "channels", labelKey: "instances.detail.tabChannels" },
      { value: "triggers", labelKey: "instances.detail.tabTriggers" },
      { value: "room", labelKey: "instances.detail.tabRoom" },
    ],
  },
  {
    key: "observability",
    titleKey: "instances.detail.groupObservability",
    tabs: [
      { value: "analytics", labelKey: "instances.detail.tabAnalytics" },
    ],
  },
  {
    key: "dataPrivacy",
    titleKey: "instances.detail.groupDataPrivacy",
    tabs: [
      { value: "privacy", labelKey: "instances.detail.tabPrivacy" },
    ],
  },
] as const;

/** Flattened tab values, in group order — the single source for the addressable-`?tab=` allowlist. */
export const INSTANCE_TAB_VALUES: readonly string[] = INSTANCE_TAB_GROUPS.flatMap((group) =>
  group.tabs.map((tab) => tab.value),
);
