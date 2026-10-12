// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TranslationKey } from "@/lib/i18n/types";
import { orgPath, workspacePath } from "@/lib/tenant/paths";
import { resolveAgentTab } from "@/lib/nav/agent-sections";

export type TourKind = "interface" | "agent";
export type TourPlace = "top" | "bottom" | "left" | "right";

/**
 * Where a step lives. The interface tour crosses pages; the agent tour stays on
 * one agent and moves between its sections, which share a pathname and differ in
 * `?tab=`.
 */
export type TourPage =
  | "dashboard"
  | "agents"
  | "conversations"
  | "playground"
  | "members"
  | `agent:${string}`;

export interface TourStep {
  id: string;
  page: TourPage;
  /** CSS selector of the real element, always a `data-tour` attribute. */
  target: string;
  place: TourPlace;
  /** `info` advances with the button; `click` waits for the person to use the element. */
  action: "info" | "click";
  /** The target sits in the sidebar, which on a phone is a drawer that must be open. */
  inSidebar?: boolean;
  /** Left out of the tour for anyone who is not a Platform Admin. */
  platformAdminOnly?: boolean;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
}

/** Interface tour: the daily surface, no agent internals. */
export const INTERFACE_TOUR: readonly TourStep[] = [
  { id: "dash", page: "dashboard", target: "[data-tour=dash-tiles]", place: "bottom", action: "info", titleKey: "onboarding.tour.dash.title", bodyKey: "onboarding.tour.dash.body" },
  { id: "nav", page: "dashboard", target: "[data-tour=nav]", place: "right", action: "info", inSidebar: true, titleKey: "onboarding.tour.nav.title", bodyKey: "onboarding.tour.nav.body" },
  { id: "nav-agents", page: "dashboard", target: "[data-tour=nav-instances]", place: "right", action: "click", inSidebar: true, titleKey: "onboarding.tour.navAgents.title", bodyKey: "onboarding.tour.navAgents.body" },
  { id: "new-agent", page: "agents", target: "[data-tour=new-agent]", place: "bottom", action: "info", titleKey: "onboarding.tour.newAgent.title", bodyKey: "onboarding.tour.newAgent.body" },
  { id: "nav-conversations", page: "agents", target: "[data-tour=nav-conversations]", place: "right", action: "click", inSidebar: true, titleKey: "onboarding.tour.navConversations.title", bodyKey: "onboarding.tour.navConversations.body" },
  { id: "conversations", page: "conversations", target: "[data-tour=conv-table]", place: "bottom", action: "info", titleKey: "onboarding.tour.conversations.title", bodyKey: "onboarding.tour.conversations.body" },
  { id: "playground", page: "playground", target: "[data-tour=chat-box]", place: "top", action: "info", titleKey: "onboarding.tour.playground.title", bodyKey: "onboarding.tour.playground.body" },
  { id: "members", page: "members", target: "[data-tour=members-table]", place: "bottom", action: "info", titleKey: "onboarding.tour.members.title", bodyKey: "onboarding.tour.members.body" },
  { id: "settings", page: "members", target: "[data-tour=nav-settings]", place: "right", action: "info", inSidebar: true, platformAdminOnly: true, titleKey: "onboarding.tour.settings.title", bodyKey: "onboarding.tour.settings.body" },
  { id: "help", page: "dashboard", target: "[data-tour=help]", place: "bottom", action: "info", titleKey: "onboarding.tour.help.title", bodyKey: "onboarding.tour.help.body" },
];

/** Agent tour: needs a real agent, and walks its sections. */
export const AGENT_TOUR: readonly TourStep[] = [
  { id: "status", page: "agent:overview", target: "[data-tour=agent-overview]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.status.title", bodyKey: "onboarding.agentTour.status.body" },
  { id: "general", page: "agent:general", target: "[data-tour=agent-general]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.general.title", bodyKey: "onboarding.agentTour.general.body" },
  { id: "model-click", page: "agent:general", target: "[data-tour=anav-settings]", place: "right", action: "click", inSidebar: true, titleKey: "onboarding.agentTour.modelClick.title", bodyKey: "onboarding.agentTour.modelClick.body" },
  { id: "model", page: "agent:settings", target: "[data-tour=agent-settings]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.model.title", bodyKey: "onboarding.agentTour.model.body" },
  { id: "prompts", page: "agent:prompts", target: "[data-tour=agent-prompts]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.prompts.title", bodyKey: "onboarding.agentTour.prompts.body" },
  { id: "tools", page: "agent:tools", target: "[data-tour=agent-tools]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.tools.title", bodyKey: "onboarding.agentTour.tools.body" },
  { id: "channels-click", page: "agent:tools", target: "[data-tour=anav-channels]", place: "right", action: "click", inSidebar: true, titleKey: "onboarding.agentTour.channelsClick.title", bodyKey: "onboarding.agentTour.channelsClick.body" },
  { id: "channels", page: "agent:channels", target: "[data-tour=channels-picker]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.channels.title", bodyKey: "onboarding.agentTour.channels.body" },
  { id: "web-auth", page: "agent:channels", target: "[data-tour=web-auth]", place: "top", action: "info", titleKey: "onboarding.agentTour.webAuth.title", bodyKey: "onboarding.agentTour.webAuth.body" },
  { id: "knowledge", page: "agent:knowledge", target: "[data-tour=agent-knowledge]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.knowledge.title", bodyKey: "onboarding.agentTour.knowledge.body" },
  { id: "params", page: "agent:params", target: "[data-tour=agent-params]", place: "bottom", action: "info", titleKey: "onboarding.agentTour.params.title", bodyKey: "onboarding.agentTour.params.body" },
];

/** The steps a given person gets: a Platform Admin sees Settings, everyone else does not. */
export function tourSteps(kind: TourKind, isPlatformAdmin: boolean): TourStep[] {
  const all = kind === "interface" ? INTERFACE_TOUR : AGENT_TOUR;
  return all.filter((step) => isPlatformAdmin || !step.platformAdminOnly);
}

export interface TourScope {
  orgSlug: string;
  workspaceSlug: string;
  /** The agent the agent tour walks; unused by the interface tour. */
  agentSlug?: string;
}

/** The URL a step lives at. */
export function tourHref(page: TourPage, scope: TourScope): string {
  const { orgSlug, workspaceSlug, agentSlug } = scope;
  switch (page) {
    case "dashboard":
      return orgPath(orgSlug);
    case "agents":
      return workspacePath(orgSlug, workspaceSlug, "/instances");
    case "conversations":
      return workspacePath(orgSlug, workspaceSlug, "/conversations");
    case "playground":
      return workspacePath(orgSlug, workspaceSlug, "/playground");
    case "members":
      return orgPath(orgSlug, "/members");
    default: {
      const tab = page.slice("agent:".length);
      return workspacePath(
        orgSlug,
        workspaceSlug,
        `/instances/${encodeURIComponent(agentSlug ?? "")}?tab=${encodeURIComponent(tab)}`,
      );
    }
  }
}

/** Whether the browser is already on the page a step needs, so the tour does not navigate. */
export function isOnTourPage(
  page: TourPage,
  scope: TourScope,
  location: { pathname: string; tab: string | null },
): boolean {
  const href = tourHref(page, scope);
  const [path] = href.split("?");
  if (location.pathname.replace(/\/$/, "") !== path.replace(/\/$/, "")) return false;
  if (!page.startsWith("agent:")) return true;
  const tab = page.slice("agent:".length);
  // An absent or unknown `tab` lands on the default section.
  return resolveAgentTab(location.tab) === tab;
}
