// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ONE column of navigation at a time.
 *
 * Entering a destination REPLACES the sidebar's contents with that destination's
 * index plus a way back out, instead of opening a second rail beside it. Two
 * adjacent vertical lists at the same visual weight read as one two-level tree cut
 * in half — neither can say "you are here", so both try to.
 *
 * There is one destination here: an agent. (The Enterprise panel has three — it
 * also has a Settings surface and an Admin Console to put behind them. The
 * mechanism is deliberately the same shape in both, so a section moving between
 * editions moves as data, not as a rewrite.)
 */

import type { LucideIcon } from "lucide-react";
import type { TranslationKey } from "@/lib/i18n/types";
import { workspacePath } from "@/lib/tenant/paths";
import { isNavActive } from "@/components/layout/nav-main";
import {
  AGENT_MACROS,
  AGENT_SECTIONS,
  agentSectionsByMacro,
  resolveAgentTab,
} from "./agent-sections";

export type DestinationKind = "agent";

export interface DestinationItem {
  key: string;
  titleKey: TranslationKey;
  href: string;
  icon: LucideIcon;
}

export interface DestinationGroup {
  key: string;
  /** `null` renders no heading — a single group does not need naming twice. */
  labelKey: TranslationKey | null;
  items: DestinationItem[];
}

export interface Destination {
  kind: DestinationKind;
  /** The object being configured, when it has a name of its own: the agent's slug. */
  subject: string | null;
  /** Where leaving goes — the destination's parent. */
  backHref: string;
  groups: DestinationGroup[];
}

/** `/organizations/{org}/workspaces/{ws}/instances/{slug}` — the DETAIL page, not the list. */
const AGENT_DETAIL = /^\/organizations\/([^/]+)\/workspaces\/([^/]+)\/instances\/([^/]+)\/?$/;

/**
 * The agent a URL addresses, or `null`.
 *
 * Matches the DETAIL page only: matching the list would replace the sidebar on the
 * very page whose entry got you there. Slugs come back decoded; a malformed escape
 * yields `null` rather than throwing.
 */
export function agentFromPath(
  pathname: string,
): { orgSlug: string; workspaceSlug: string; agentSlug: string } | null {
  const match = AGENT_DETAIL.exec(pathname);
  if (!match) return null;
  try {
    return {
      orgSlug: decodeURIComponent(match[1]),
      workspaceSlug: decodeURIComponent(match[2]),
      agentSlug: decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

/**
 * The agent's macro entries — not its leaves. Each links to the first section it
 * holds, and the page it opens carries the rest as a tab row.
 *
 * One group and no heading: the rows are few enough to read, and a heading over the
 * whole of them would name the agent twice — its slug is already the subject above.
 */
function agentGroups(orgSlug: string, workspaceSlug: string, agentSlug: string): DestinationGroup[] {
  const base = workspacePath(orgSlug, workspaceSlug, `/instances/${encodeURIComponent(agentSlug)}`);
  return AGENT_MACROS.flatMap(({ macro, titleKey }) => {
    const sections = agentSectionsByMacro(macro);
    // A macro with no section would be a heading over nothing.
    if (sections.length === 0) return [];
    return [
      {
        key: macro,
        labelKey: titleKey,
        items: sections.map((section) => ({
          key: section.tab,
          titleKey: section.titleKey,
          href: `${base}?tab=${section.tab}`,
          icon: section.icon,
        })),
      },
    ];
  });
}

/** Resolve the destination the URL is inside, or `null` for the daily surface. */
export function resolveDestination(pathname: string): Destination | null {
  const agent = agentFromPath(pathname);
  if (!agent) return null;
  return {
    kind: "agent",
    subject: agent.agentSlug,
    // Out of an agent is its workspace's agent list — the page you came from.
    backHref: workspacePath(agent.orgSlug, agent.workspaceSlug, "/instances"),
    groups: agentGroups(agent.orgSlug, agent.workspaceSlug, agent.agentSlug),
  };
}

/**
 * Whether a destination item is the one being viewed.
 *
 * The agent's sections all share ONE pathname and differ only in `?tab=`, so the
 * path comparison every other nav surface uses would mark every one of them active
 * at once. When an item's href carries a tab, the tab decides.
 *
 * And it decides by LEAF: a sidebar row is a macro entry linking to
 * the first section it holds, so it must stay lit while you move along that page's
 * tab row — otherwise opening the second tab of Comportamento leaves the sidebar
 * with nothing lit at all. `resolveAgentTab` is applied first, so a legacy or absent
 * `?tab=` lights the entry the page actually rendered.
 *
 * @param currentTab the URL's `tab` parameter, or `null` when it carries none.
 */
export function isDestinationItemActive(
  href: string,
  pathname: string,
  currentTab: string | null,
): boolean {
  const [path, query] = href.split("?");
  const itemTab = query ? new URLSearchParams(query).get("tab") : null;
  if (!itemTab) return isNavActive(pathname, href);
  return isNavActive(pathname, path, true) && resolveAgentTab(currentTab) === itemTab;
}

/**
 * A stable id for "which navigation the sidebar is showing" — `"root"` for the daily
 * list, otherwise the destination and, for an agent, which one.
 *
 * Drives the slide transition: it is the React `key` that remounts the pane so the
 * animation replays, and the pair of keys before/after a change says whether you
 * nested IN or came back OUT. Deliberately does NOT vary with the section you are
 * on: moving between two sections of one destination leaves the menu unchanged, so
 * it must not animate.
 */
export function navTransitionKey(destination: Destination | null): string {
  if (!destination) return "root";
  return `${destination.kind}:${destination.subject ?? ""}`;
}

/**
 * How deep a `navTransitionKey` sits: the daily list is 0, every destination is 1.
 *
 * Agent-to-agent is 1→1, and treated as nesting in — it is a sibling move, and "in"
 * is the honest reading of arriving somewhere new.
 */
export function navTransitionDepth(key: string): number {
  return key === "root" ? 0 : 1;
}

/** Every section of every destination. */
export const DESTINATION_SECTION_COUNT = AGENT_SECTIONS.length;
