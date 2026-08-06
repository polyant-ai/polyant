// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent's navigation: a handful of entries in the sidebar, each opening a page
 * whose tab row holds its sections.
 *
 * Two levels, because one was never enough and thirteen peers were too many. The
 * thirteen were not peers at all — and the giveaway was that Trigger already
 * carried three tabs INSIDE itself, so a third level existed anyway, just
 * undeclared. Making it the official level removes the special case: Trigger's
 * three are now leaves of Automazioni, rendered by the same tab row as everything
 * else, and `triggers-tab.tsx` (a wrapper whose only job was that inner tab bar)
 * is gone.
 *
 * **The address is still `?tab=<leaf>`.** The macro entry is DERIVED from the leaf
 * (`macroOfTab`), so no second parameter was invented and the sidebar lights the
 * entry containing the active leaf. There is no alias table: the tenant-scoped
 * URLs are canonical everywhere in the panel, and a `?tab=` value that no longer
 * names a section degrades to the default section like any other unknown value.
 */

import { Gauge, Brain, Settings2, Radio, Webhook, Shield } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TranslationKey } from "@/lib/i18n/types";

/** A sidebar entry of the agent destination. */
export type AgentMacro =
  | "overview"
  | "configuration"
  | "behaviour"
  | "channels"
  | "automation"
  | "governance";

export interface AgentSectionDef {
  /** The `?tab=` value — this section's address and its stable key. */
  tab: string;
  titleKey: TranslationKey;
  macro: AgentMacro;
}

/** Sidebar order. */
export const AGENT_MACROS: readonly {
  macro: AgentMacro;
  titleKey: TranslationKey;
  icon: LucideIcon;
}[] = [
  { macro: "overview", titleKey: "instances.macro.overview", icon: Gauge },
  // Configurazione before Comportamento: what the agent IS and what runs it comes
  // before what it says. A new agent is configured first, and the order is read
  // top-down.
  { macro: "configuration", titleKey: "instances.macro.configuration", icon: Settings2 },
  { macro: "behaviour", titleKey: "instances.macro.behaviour", icon: Brain },
  { macro: "channels", titleKey: "instances.macro.channels", icon: Radio },
  { macro: "automation", titleKey: "instances.macro.automation", icon: Webhook },
  { macro: "governance", titleKey: "instances.macro.governance", icon: Shield },
];

export const AGENT_SECTIONS: readonly AgentSectionDef[] = [
  // Panoramica — what the agent did over a period.
  { tab: "analytics", titleKey: "instances.detail.tabAnalytics", macro: "overview" },

  // Configurazione — what the agent IS and what runs it.
  { tab: "general", titleKey: "instances.detail.tabGeneral", macro: "configuration" },
  { tab: "settings", titleKey: "instances.detail.tabSettings", macro: "configuration" },

  // Comportamento — what the agent knows, can do, and how it answers. Hooks belong
  // HERE rather than with the automations: a hook intercepts the lifecycle to
  // change the reply, which is behaviour, not scheduling.
  { tab: "prompts", titleKey: "instances.detail.tabPrompts", macro: "behaviour" },
  { tab: "tools", titleKey: "instances.detail.tabTools", macro: "behaviour" },
  // External MCP servers sit next to Tools on purpose: they answer the same
  // question ("what can this agent do"), for capabilities that live outside the
  // engine — their tools reach the model as `mcp__<server>__*`.
  { tab: "mcp", titleKey: "instances.detail.tabMcp", macro: "behaviour" },
  { tab: "skills", titleKey: "instances.detail.tabSkills", macro: "behaviour" },
  { tab: "knowledge", titleKey: "instances.detail.tabKnowledge", macro: "behaviour" },
  { tab: "hooks", titleKey: "instances.detail.tabHooks", macro: "behaviour" },

  // Canali — ONE section, not one per channel: `ChannelsTab` renders every channel
  // on a single page here. Splitting it the way a per-channel form would deserve is
  // a change to that component, not to this registry.
  { tab: "channels", titleKey: "instances.detail.tabChannels", macro: "channels" },

  // Automazioni — what makes the agent act with nobody asking. The first three are
  // Trigger's own tabs, flattened out of it.
  { tab: "webhooks", titleKey: "triggers.webhooks", macro: "automation" },
  { tab: "scheduled", titleKey: "triggers.scheduled", macro: "automation" },
  { tab: "runs", titleKey: "triggers.runs", macro: "automation" },
  { tab: "room", titleKey: "instances.detail.tabRoom", macro: "automation" },

  // Governance — the rules it runs under. Gates, policies, retention and compliance
  // are Enterprise; what ships here is the data-privacy section.
  { tab: "privacy", titleKey: "instances.detail.tabPrivacy", macro: "governance" },
];

/** Where the page lands with no (or an unusable) `?tab=`. */
export const DEFAULT_AGENT_TAB = "general";

export const AGENT_TAB_VALUES: readonly string[] = AGENT_SECTIONS.map((s) => s.tab);

/** Sections of one macro entry, in registry order — the page's tab row. */
export function agentSectionsByMacro(macro: AgentMacro): AgentSectionDef[] {
  return AGENT_SECTIONS.filter((section) => section.macro === macro);
}

/**
 * Resolve a raw `?tab=` into a section that exists: absent, unknown or stale values
 * all fall back to the landing page. One place, so the page and the sidebar can
 * never disagree about which section is open.
 */
export function resolveAgentTab(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_AGENT_TAB;
  return AGENT_TAB_VALUES.includes(raw) ? raw : DEFAULT_AGENT_TAB;
}

/** The sidebar entry containing a leaf — what makes `?tab=` sufficient on its own. */
export function macroOfTab(tab: string): AgentMacro {
  return AGENT_SECTIONS.find((s) => s.tab === tab)?.macro ?? "configuration";
}
