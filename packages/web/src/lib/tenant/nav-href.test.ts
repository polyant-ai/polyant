// SPDX-License-Identifier: AGPL-3.0-or-later

import { navHref, resolveNavScope } from "./nav-href";
import type { TenantContextValue } from "./tenant-context";

const RESOLVED = { orgSlug: "default", workspaceSlug: "general" };

const READY_TENANT: TenantContextValue = {
  status: "ready",
  organization: { slug: "default", name: "Default" },
  workspaces: [{ slug: "general", name: "General", isDefault: true }],
  retry: () => {},
};

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
    expect(navHref("workspace", "/agents", RESOLVED)).toBe(
      "/organizations/default/workspaces/general/agents",
    );
  });

  it("falls back to the resolver when the org is unknown", () => {
    expect(navHref("org", "/members", { orgSlug: null, workspaceSlug: null })).toBe("/");
  });

  it("falls back to the resolver when the workspace is unknown", () => {
    expect(navHref("workspace", "/agents", { orgSlug: "default", workspaceSlug: null })).toBe(
      "/",
    );
  });

  it("falls back to the resolver for a workspace-scoped link when the org is unknown", () => {
    expect(navHref("workspace", "/agents", { orgSlug: null, workspaceSlug: "general" })).toBe(
      "/",
    );
  });
});

describe("resolveNavScope", () => {
  it("ignores a foreign orgSlug in the params in favour of the tenant's own", () => {
    expect(resolveNavScope(READY_TENANT, { orgSlug: "ghost", workspaceSlug: "general" })).toEqual(
      { orgSlug: "default", workspaceSlug: "general" },
    );
  });

  it("honours a workspaceSlug the caller holds", () => {
    expect(resolveNavScope(READY_TENANT, { workspaceSlug: "general" })).toEqual(RESOLVED);
  });

  it("falls back to the default workspace when the params name one the caller does not hold", () => {
    expect(resolveNavScope(READY_TENANT, { workspaceSlug: "ghost" })).toEqual(RESOLVED);
  });

  it("yields the tenant's org plus its default workspace when there are no params", () => {
    expect(resolveNavScope(READY_TENANT, {})).toEqual(RESOLVED);
  });

  it("yields null slugs for a tenant that is not ready", () => {
    expect(
      resolveNavScope({ status: "loading", retry: () => {} }, { orgSlug: "default" }),
    ).toEqual({ orgSlug: null, workspaceSlug: null });
  });
});
