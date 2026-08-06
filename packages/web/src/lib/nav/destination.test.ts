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

  // Every macro that holds a section becomes one entry, linking to its FIRST leaf.
  it("offers one entry per non-empty macro, each landing on its first section", () => {
    const items = resolveDestination(AGENT)!.groups.flatMap((g) => g.items);
    const nonEmpty = AGENT_MACROS.filter(({ macro }) => agentSectionsByMacro(macro).length > 0);

    expect(items).toHaveLength(nonEmpty.length);
    for (const { macro } of nonEmpty) {
      const landing = agentSectionsByMacro(macro)[0];
      expect(items.find((i) => i.key === macro)?.href).toBe(`${AGENT}?tab=${landing.tab}`);
    }
  });
});

describe("isDestinationItemActive", () => {
  // The sections share ONE pathname and differ only in `?tab=`, so a path
  // comparison would light every entry at once.
  it("lights by MACRO, so an entry stays lit across its own tab row", () => {
    const behaviour = `${AGENT}?tab=prompts`;
    expect(isDestinationItemActive(behaviour, AGENT, "prompts")).toBe(true);
    // `hooks` is another section of the same macro — the entry must stay lit.
    expect(macroOfTab("hooks")).toBe(macroOfTab("prompts"));
    expect(isDestinationItemActive(behaviour, AGENT, "hooks")).toBe(true);
    // A section of a different macro must not light it.
    expect(isDestinationItemActive(behaviour, AGENT, "privacy")).toBe(false);
  });

  it("treats an absent tab as the default section", () => {
    const landing = `${AGENT}?tab=${resolveAgentTab(null)}`;
    expect(isDestinationItemActive(landing, AGENT, null)).toBe(true);
  });
});

describe("resolveAgentTab", () => {
  it("keeps a real section, aliases a folded one, and falls back otherwise", () => {
    expect(resolveAgentTab("prompts")).toBe("prompts");
    // `triggers` stopped being one section holding three; its first leaf is the
    // landing. A bookmark is a contract.
    expect(resolveAgentTab("triggers")).toBe("webhooks");
    expect(resolveAgentTab("not-a-section")).toBe(resolveAgentTab(null));
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
