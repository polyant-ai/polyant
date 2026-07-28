// SPDX-License-Identifier: AGPL-3.0-or-later

import { navHref } from "./nav-href";

const RESOLVED = { orgSlug: "default", workspaceSlug: "general" };

describe("navHref", () => {
  it("passes a deployment-level path through untouched", () => {
    expect(navHref("deployment", "/settings", RESOLVED)).toBe("/settings");
  });

  it("does not need a tenant for a deployment-level path", () => {
    expect(navHref("deployment", "/skills", { orgSlug: null, workspaceSlug: null })).toBe(
      "/skills",
    );
  });

  it("builds an org-level path", () => {
    expect(navHref("org", "/members", RESOLVED)).toBe("/organizations/default/members");
  });

  it("builds the org root for an empty path (the dashboard)", () => {
    expect(navHref("org", "", RESOLVED)).toBe("/organizations/default");
  });

  it("builds a workspace-level path", () => {
    expect(navHref("workspace", "/instances", RESOLVED)).toBe(
      "/organizations/default/workspaces/general/instances",
    );
  });

  it("falls back to the resolver when the org is unknown", () => {
    expect(navHref("org", "/members", { orgSlug: null, workspaceSlug: null })).toBe("/");
  });

  it("falls back to the resolver when the workspace is unknown", () => {
    expect(navHref("workspace", "/instances", { orgSlug: "default", workspaceSlug: null })).toBe(
      "/",
    );
  });
});
