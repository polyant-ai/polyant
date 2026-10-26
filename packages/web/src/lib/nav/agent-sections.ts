// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent's navigation: every section is a SIDEBAR row, grouped under headings.
 * No tab row.
 *
 * Moving the sections into the sidebar removed the "which macro was that in?"
 * step: the whole vocabulary is visible and every section is one click away. A
 * section is a place you GO; a lone switch is a row on a page. So the count came
 * down by merging what nobody read apart:
 *
 * - **Strumenti** and **MCP** answer the same question ("what can this agent do")
 *   and sit side by side under Risorse, each with its own row.
 * - **Credenziali** and **Parametri** are gone as destinations: a key is set beside
 *   what uses it. A provider key sits in the Modello block of the task that reads
 *   it (conversation, embeddings, transcription), a tool's key in that tool's
 *   panel, a hook's on the Hooks page.
 * - **Avanzate**: memory, the per-turn parameters and the tracing were three
 *   different destinations for one subject — what the engine carries into a turn
 *   and what it keeps after.
 * - **Panoramica** also holds the agent's conversations and its run log (Monitor):
 *   they were workspace-wide pages only, so finding one agent's meant opening a
 *   filter. The engine already takes `instanceId` on all of them.
 *
 * Six groups, in this order: Panoramica, Configurazione, Conoscenza, Risorse,
 * Automazioni, Governance. Registry order is row order.
 *
 * **The address is still `?tab=<section>`.** There is no alias table: a `?tab=`
 * value that no longer names a section degrades to the landing page like any other
 * unknown value.
 *
 * A build with more sections (governance gates, compliance, retention, tool
 * traces) adds rows to this list; the shape stays the same, only the rows differ.
 */

import {
  Gauge,
  Settings2,
  Webhook,
  Shield,
  LayoutDashboard,
  MessageSquareText,
  Wrench,
  Zap,
  BookOpen,
  Anchor,
  Activity,
  IdCard,
  MessageSquare,
  SlidersHorizontal,
  Cpu,
  Radio,
  CalendarClock,
  DoorOpen,
  EyeOff,
  Plug,
  Brain,
  Library,
  Boxes,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TranslationKey } from "@/lib/i18n/types";

/** A group heading of the agent destination. */
export type AgentMacro =
  | "overview"
  | "configuration"
  | "knowledge"
  | "resources"
  | "automation"
  | "governance";

export interface AgentSectionDef {
  /** The `?tab=` value — this section's address and its stable key. */
  tab: string;
  titleKey: TranslationKey;
  macro: AgentMacro;
  /**
   * Its own glyph, now that the section IS the sidebar row: repeating the macro's
   * icon down a group would make identical stacks, and a collapsed sidebar (labels
   * and group headings both hidden) would have nothing left to read.
   */
  icon: LucideIcon;
  /**
   * The line under the section's title, the same place and style in every
   * section: the page draws it, so no section words its own intro differently.
   */
  descriptionKey: TranslationKey;
}

/** Group headings, in order. */
export const AGENT_MACROS: readonly {
  macro: AgentMacro;
  titleKey: TranslationKey;
  icon: LucideIcon;
}[] = [
  { macro: "overview", titleKey: "instances.macro.overview", icon: Gauge },
  // Configuration before knowledge and resources: what the agent IS and what runs
  // it comes before what it knows and can use. A new agent is configured first,
  // and the order is read top-down.
  { macro: "configuration", titleKey: "instances.macro.configuration", icon: Settings2 },
  { macro: "knowledge", titleKey: "instances.macro.knowledge", icon: Library },
  { macro: "resources", titleKey: "instances.macro.resources", icon: Boxes },
  { macro: "automation", titleKey: "instances.macro.automation", icon: Webhook },
  { macro: "governance", titleKey: "instances.macro.governance", icon: Shield },
];

export const AGENT_SECTIONS: readonly AgentSectionDef[] = [
  // Panoramica — whether the agent is well, what it did over a period, what it
  // has been saying, and the run log behind it.
  { tab: "overview", titleKey: "instances.detail.tabStatus", macro: "overview", icon: IdCard, descriptionKey: "agentSection.overview" },
  { tab: "analytics", titleKey: "instances.detail.tabAnalytics", macro: "overview", icon: LayoutDashboard, descriptionKey: "agentSection.analytics" },
  { tab: "conversations", titleKey: "nav.conversations", macro: "overview", icon: MessageSquare, descriptionKey: "agentSection.conversations" },
  { tab: "logs", titleKey: "instances.detail.tabLogs", macro: "overview", icon: Activity, descriptionKey: "agentSection.logs" },

  // Configurazione — what the agent IS, what runs it, and how it is reached.
  { tab: "general", titleKey: "instances.detail.tabGeneral", macro: "configuration", icon: Settings2, descriptionKey: "agentSection.general" },
  { tab: "prompts", titleKey: "instances.detail.tabPrompts", macro: "configuration", icon: MessageSquareText, descriptionKey: "agentSection.prompts" },
  // No Credenziali row: a provider key is set in the Modello section, in the
  // block of the task that uses it, next to the choice that needs it.
  { tab: "settings", titleKey: "instances.detail.tabSettings", macro: "configuration", icon: Cpu, descriptionKey: "agentSection.settings" },
  // ONE section for every channel: the channel is picked inside it.
  { tab: "channels", titleKey: "instances.detail.tabChannels", macro: "configuration", icon: Radio, descriptionKey: "agentSection.channels" },
  // Memory, the per-turn parameters and the tracing.
  { tab: "params", titleKey: "instances.detail.tabParams", macro: "configuration", icon: SlidersHorizontal, descriptionKey: "agentSection.params" },

  // Conoscenza — what the agent knows and remembers.
  { tab: "knowledge", titleKey: "instances.detail.tabKnowledge", macro: "knowledge", icon: BookOpen, descriptionKey: "agentSection.knowledge" },
  { tab: "memories", titleKey: "nav.memory", macro: "knowledge", icon: Brain, descriptionKey: "agentSection.memories" },

  // Risorse — what the agent can use. The parameters a tool declares are
  // configured in that tool's own panel: a key exists because something asked for
  // it, so it is set beside that thing rather than on a page of loose fields.
  { tab: "skills", titleKey: "instances.detail.tabSkills", macro: "resources", icon: Zap, descriptionKey: "agentSection.skills" },
  { tab: "tools", titleKey: "instances.detail.tabTools", macro: "resources", icon: Wrench, descriptionKey: "agentSection.tools" },
  /*
    External MCP servers — a section of its own, after the tools and their keys.

    It was a block at the bottom of the Tools page, on the argument that "what can
    this agent do" is one question whichever side of the engine boundary answers
    it. In the sidebar that reasoning stops holding: an MCP server is a CONNECTION
    this agent holds credentials for and reaches over the network, configured and
    debugged as its own thing, and it was findable only by scrolling past a list
    of forty switches that has its own search and filters. Its own row is one
    click; the bottom of another page is not addressable at all.
  */
  { tab: "mcp", titleKey: "instances.detail.tabMcp", macro: "resources", icon: Plug, descriptionKey: "agentSection.mcp" },

  // Automazioni — what makes the agent act. A hook intercepts the lifecycle, the
  // others fire on an event or a schedule.
  { tab: "hooks", titleKey: "instances.detail.tabHooks", macro: "automation", icon: Anchor, descriptionKey: "agentSection.hooks" },
  { tab: "webhooks", titleKey: "triggers.webhooks", macro: "automation", icon: Webhook, descriptionKey: "agentSection.webhooks" },
  { tab: "scheduled", titleKey: "triggers.scheduled", macro: "automation", icon: CalendarClock, descriptionKey: "agentSection.scheduled" },
  { tab: "room", titleKey: "instances.detail.tabRoom", macro: "automation", icon: DoorOpen, descriptionKey: "agentSection.room" },

  // Governance — what ships here is the data-privacy section.
  { tab: "privacy", titleKey: "instances.detail.tabPrivacy", macro: "governance", icon: EyeOff, descriptionKey: "agentSection.privacy" },
];

/**
 * Where the page lands with no (or an unusable) `?tab=`.
 *
 * Stato, not Generale: arriving on an agent, the first question is whether it
 * works, and the second is what it is. Generale answers neither — it holds the
 * name and the description, which is the one thing the page header already says.
 */
export const DEFAULT_AGENT_TAB = "overview";

export const AGENT_TAB_VALUES: readonly string[] = AGENT_SECTIONS.map((s) => s.tab);

/** Sections of one macro, in registry order — the rows under its heading. */
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

/** The heading a section sits under — which group of the sidebar holds its row. */
export function macroOfTab(tab: string): AgentMacro {
  return AGENT_SECTIONS.find((s) => s.tab === tab)?.macro ?? "overview";
}

/** The section a `?tab=` names, already resolved — what the page titles itself with. */
export function agentSection(tab: string): AgentSectionDef {
  const resolved = resolveAgentTab(tab);
  // Non-null: `resolveAgentTab` only ever returns a registered tab.
  return AGENT_SECTIONS.find((s) => s.tab === resolved)!;
}
