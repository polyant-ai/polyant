// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TOUR, INTERFACE_TOUR, isOnTourPage, tourHref, tourSteps } from "./tours";

const scope = { orgSlug: "acme", workspaceSlug: "general", agentSlug: "support bot" };

describe("tour step lists", () => {
  it("interface tour has ten steps for a Platform Admin and drops Settings for everyone else", () => {
    expect(tourSteps("interface", true)).toHaveLength(10);
    const others = tourSteps("interface", false).map((s) => s.id);
    expect(others).toHaveLength(9);
    expect(others).not.toContain("settings");
  });

  it("agent tour has eleven steps and two that wait for a click", () => {
    expect(AGENT_TOUR).toHaveLength(11);
    expect(AGENT_TOUR.filter((s) => s.action === "click")).toHaveLength(2);
  });

  it("every step id is unique within its tour", () => {
    for (const tour of [INTERFACE_TOUR, AGENT_TOUR]) {
      expect(new Set(tour.map((s) => s.id)).size).toBe(tour.length);
    }
  });
});

describe("tour addresses", () => {
  it.each([
    ["dashboard", "/organizations/acme"],
    ["agents", "/organizations/acme/workspaces/general/instances"],
    ["conversations", "/organizations/acme/workspaces/general/conversations"],
    ["playground", "/organizations/acme/workspaces/general/playground"],
    ["members", "/organizations/acme/members"],
    ["agent:channels", "/organizations/acme/workspaces/general/instances/support%20bot?tab=channels"],
  ] as const)("%s lives at %s", (page, href) => {
    expect(tourHref(page, scope)).toBe(href);
  });

  it("does not navigate when the browser is already on the step's page", () => {
    expect(isOnTourPage("agents", scope, { pathname: "/organizations/acme/workspaces/general/instances/", tab: null })).toBe(true);
    expect(isOnTourPage("agents", scope, { pathname: "/organizations/acme", tab: null })).toBe(false);
  });

  it("treats the agent's landing section as the same page with or without ?tab", () => {
    const path = "/organizations/acme/workspaces/general/instances/support%20bot";
    expect(isOnTourPage("agent:overview", scope, { pathname: path, tab: null })).toBe(true);
    expect(isOnTourPage("agent:general", scope, { pathname: path, tab: null })).toBe(false);
    expect(isOnTourPage("agent:general", scope, { pathname: path, tab: "general" })).toBe(true);
  });
});

/** Every `data-tour` name a step points at must exist in the product's source. */
describe("tour targets exist in the source", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !full.includes(join("lib", "onboarding", "tours.ts"))
        ? [readFileSync(full, "utf8")]
        : [];
    });
  }
  const all = sources(root).join("\n");

  it("finds source files to search", () => {
    expect(all.length).toBeGreaterThan(10_000);
  });

  it.each([...INTERFACE_TOUR, ...AGENT_TOUR].map((s) => [s.id, s.target] as const))("%s -> %s", (_id, target) => {
    const name = /\[data-tour=([\w-]+)\]/.exec(target)?.[1];
    expect(name, `target ${target} is not a data-tour selector`).toBeTruthy();
    // Direct attribute, a computed prefix (nav-*, anav-*, agent-<tab>) or the sidebar's own item key.
    const prefix = name!.split("-")[0];
    const direct = all.includes(`data-tour="${name}"`) || all.includes(`data-tour=\\"${name}\\"`);
    const computed =
      (prefix === "nav" && all.includes('`nav-${')) ||
      (prefix === "anav" && all.includes("`anav-${")) ||
      (prefix === "agent" && all.includes('data-tour="agent-')) ||
      (name === "nav-dashboard" || prefix === "nav") && all.includes('"nav-dashboard"');
    expect(direct || computed).toBe(true);
  });
});
