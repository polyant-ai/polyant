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

  it("draws six groups in order, each holding its own rows in order", () => {
    // Catches a section landing under the wrong heading or the groups being reordered.
    const groups = resolveDestination(AGENT)!.groups;
    expect(groups.map((g) => [g.key, g.items.map((item) => item.key)])).toEqual([
      ["overview", ["overview", "analytics", "conversations", "logs"]],
      ["configuration", ["general", "prompts", "settings", "channels", "params"]],
      ["knowledge", ["knowledge", "memories"]],
      ["resources", ["skills", "tools", "mcp"]],
      ["automation", ["hooks", "webhooks", "scheduled", "room"]],
      ["governance", ["privacy"]],
    ]);
    expect(groups).toHaveLength(AGENT_MACROS.length);
    expect(groups.flatMap((group) => group.items)).toHaveLength(AGENT_SECTIONS.length);
  });

  it("links every row to its own ?tab= value, so existing addresses keep working", () => {
    const rows = resolveDestination(AGENT)!.groups.flatMap((group) => group.items);
    for (const row of rows) expect(row.href).toBe(`${AGENT}?tab=${row.key}`);
  });
});

describe("isDestinationItemActive", () => {
  /**
   * The sections share ONE pathname and differ only in `?tab=`, so a path
   * comparison would light every row at once. By LEAF, not by macro: every
   * section has its own row, and lighting the macro would light every row of
   * its group for one open page.
   */
  it("lights one row per open section, not its whole macro", () => {
    const prompts = `${AGENT}?tab=prompts`;
    expect(isDestinationItemActive(prompts, AGENT, "prompts")).toBe(true);
    // `general` shares the group and must stay dark all the same.
    expect(macroOfTab("general")).toBe(macroOfTab("prompts"));
    expect(isDestinationItemActive(prompts, AGENT, "general")).toBe(false);
    expect(isDestinationItemActive(prompts, AGENT, "privacy")).toBe(false);
  });

  it("lights only the open automation row, not its siblings", () => {
    // Catches the old behaviour where Webhook stayed lit for every automation tab.
    const webhooks = `${AGENT}?tab=webhooks`;
    expect(isDestinationItemActive(webhooks, AGENT, "webhooks")).toBe(true);
    for (const tab of ["hooks", "scheduled", "room"]) {
      expect(isDestinationItemActive(webhooks, AGENT, tab)).toBe(false);
    }
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
