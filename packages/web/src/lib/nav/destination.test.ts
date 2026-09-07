// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  agentFromPath,
  isDestinationItemActive,
  navTransitionDepth,
  navTransitionKey,
  resolveDestination,
} from "./destination";
import {
  AGENT_MACROS,
  AGENT_SECTIONS,
  agentSectionsByMacro,
  DEFAULT_AGENT_TAB,
  macroOfTab,
  resolveAgentTab,
} from "./agent-sections";

const AGENT = "/organizations/acme/workspaces/vendite/instances/bot-1";

describe("agentFromPath", () => {
  it("matches the detail page and decodes its slugs", () => {
    expect(agentFromPath(AGENT)).toEqual({
      orgSlug: "acme",
      workspaceSlug: "vendite",
      agentSlug: "bot-1",
    });
    expect(agentFromPath("/organizations/a%20b/workspaces/w/instances/x")?.orgSlug).toBe("a b");
  });

  // Matching the list would replace the sidebar on the very page whose entry got
  // you there — you would lose the way back the moment you needed it.
  it("does NOT match the agent list, and survives a malformed escape", () => {
    expect(agentFromPath("/organizations/acme/workspaces/vendite/instances")).toBeNull();
    expect(agentFromPath("/organizations/%E0%A4%A/workspaces/w/instances/x")).toBeNull();
  });
});

describe("resolveDestination", () => {
  it("is null on the daily surface and an agent on the detail page", () => {
    expect(resolveDestination("/organizations/acme")).toBeNull();
    const d = resolveDestination(AGENT);
    expect(d?.kind).toBe("agent");
    expect(d?.subject).toBe("bot-1");
    // Out of an agent is its workspace's agent list — the page you came from.
    expect(d?.backHref).toBe("/organizations/acme/workspaces/vendite/instances");
  });

  /**
   * Every SECTION is a row now, grouped under its macro's heading. It was one row
   * per macro landing on its first section, with the rest behind a tab row — so
   * finding a section meant remembering which macro held it.
   */
  it("makes one group per non-empty macro, holding a row per section", () => {
    const groups = resolveDestination(AGENT)!.groups;
    const nonEmpty = AGENT_MACROS.filter(({ macro }) => agentSectionsByMacro(macro).length > 0);

    expect(groups).toHaveLength(nonEmpty.length);
    expect(groups.flatMap((g) => g.items)).toHaveLength(AGENT_SECTIONS.length);

    for (const { macro, titleKey } of nonEmpty) {
      const group = groups.find((g) => g.key === macro)!;
      expect(group.labelKey).toBe(titleKey);
      expect(group.items.map((i) => i.href)).toEqual(
        agentSectionsByMacro(macro).map((section) => `${AGENT}?tab=${section.tab}`),
      );
    }
  });
});

describe("isDestinationItemActive", () => {
  /**
   * The sections share ONE pathname and differ only in `?tab=`, so a path
   * comparison would light every row at once. By LEAF, not by macro: every
   * section has its own row now, and lighting the macro would light all seven
   * rows of Comportamento for one open page.
   */
  it("lights one row per open section, not its whole macro", () => {
    const behaviour = `${AGENT}?tab=prompts`;
    expect(isDestinationItemActive(behaviour, AGENT, "prompts")).toBe(true);
    // `hooks` shares the macro and must stay dark all the same.
    expect(macroOfTab("hooks")).toBe(macroOfTab("prompts"));
    expect(isDestinationItemActive(behaviour, AGENT, "hooks")).toBe(false);
    expect(isDestinationItemActive(behaviour, AGENT, "privacy")).toBe(false);
  });

  // A stale address lights the row whose page actually renders — the fallback is
  // applied before the comparison, not after, so the sidebar and the page agree
  // even when the URL names nothing.
  it("lights the row a stale address resolves into", () => {
    expect(isDestinationItemActive(`${AGENT}?tab=${DEFAULT_AGENT_TAB}`, AGENT, "triggers")).toBe(true);
  });

  it("treats an absent tab as the default section", () => {
    const landing = `${AGENT}?tab=${resolveAgentTab(null)}`;
    expect(isDestinationItemActive(landing, AGENT, null)).toBe(true);
  });
});

describe("resolveAgentTab", () => {
  it("keeps a real section and falls back otherwise", () => {
    expect(resolveAgentTab("prompts")).toBe("prompts");
    // No alias table: legacy URLs are dropped deliberately across the panel, so a
    // `?tab=` value that no longer names a section is just an unknown value.
    expect(resolveAgentTab("triggers")).toBe(DEFAULT_AGENT_TAB);
    expect(resolveAgentTab("not-a-section")).toBe(DEFAULT_AGENT_TAB);
    expect(resolveAgentTab(null)).toBe(DEFAULT_AGENT_TAB);
    expect(resolveAgentTab("")).toBe(DEFAULT_AGENT_TAB);
  });

  it("resolves every registered tab to itself", () => {
    for (const { tab } of AGENT_SECTIONS) expect(resolveAgentTab(tab)).toBe(tab);
  });
});

describe("navTransitionKey / navTransitionDepth", () => {
  // Moving between two sections of one agent leaves the menu unchanged, so it
  // must not animate: the key has to be identical.
  it("does not vary with the section, only with the destination", () => {
    const a = navTransitionKey(resolveDestination(AGENT));
    expect(a).toBe(navTransitionKey(resolveDestination(AGENT)));
    expect(a).not.toBe(navTransitionKey(null));
  });

  it("puts the daily list at 0 and every destination at 1", () => {
    expect(navTransitionDepth(navTransitionKey(null))).toBe(0);
    expect(navTransitionDepth(navTransitionKey(resolveDestination(AGENT)))).toBe(1);
  });
});
