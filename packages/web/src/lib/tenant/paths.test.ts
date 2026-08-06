// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  orgPath,
  workspacePath,
  withWorkspaceSlug,
  workspaceSlugFromPath,
  PLATFORM_PREFIX,
} from "./paths";

describe("orgPath", () => {
  it("builds the organization root", () => {
    expect(orgPath("acme")).toBe("/organizations/acme");
  });

  it("appends a sub-path", () => {
    expect(orgPath("acme", "/members")).toBe("/organizations/acme/members");
  });

  it("tolerates a sub-path without a leading slash", () => {
    expect(orgPath("acme", "members")).toBe("/organizations/acme/members");
  });

  it("treats a bare slash as no sub-path", () => {
    expect(orgPath("acme", "/")).toBe("/organizations/acme");
  });

  it("encodes the slug", () => {
    expect(orgPath("a b")).toBe("/organizations/a%20b");
  });
});

describe("workspacePath", () => {
  it("builds the workspace root", () => {
    expect(workspacePath("acme", "core")).toBe("/organizations/acme/workspaces/core");
  });

  it("appends a sub-path", () => {
    expect(workspacePath("acme", "core", "/agents")).toBe(
      "/organizations/acme/workspaces/core/agents",
    );
  });

  it("preserves a query string in the sub-path", () => {
    expect(workspacePath("acme", "core", "/conversations?id=42")).toBe(
      "/organizations/acme/workspaces/core/conversations?id=42",
    );
  });

  it("encodes both slugs", () => {
    expect(workspacePath("a b", "c d")).toBe("/organizations/a%20b/workspaces/c%20d");
  });
});

describe("PLATFORM_PREFIX", () => {
  it("is reserved outside the tenant tree", () => {
    expect(PLATFORM_PREFIX).toBe("/platform");
  });
});

describe("withWorkspaceSlug", () => {
  it("re-points a workspace-scoped path at another workspace", () => {
    expect(
      withWorkspaceSlug("/organizations/acme/workspaces/core/agents/bot-1", "sales"),
    ).toBe("/organizations/acme/workspaces/sales/agents/bot-1");
  });

  it("keeps the query string and the org segment", () => {
    expect(
      withWorkspaceSlug("/organizations/acme/workspaces/core/conversations", "sales"),
    ).toBe("/organizations/acme/workspaces/sales/conversations");
  });

  it("handles the workspace root with no sub-path", () => {
    expect(withWorkspaceSlug("/organizations/acme/workspaces/core", "sales")).toBe(
      "/organizations/acme/workspaces/sales",
    );
  });

  it("returns null on an org-level path — there is no segment to swap", () => {
    expect(withWorkspaceSlug("/organizations/acme/members", "sales")).toBeNull();
  });

  it("returns null on a deployment-level path", () => {
    expect(withWorkspaceSlug("/settings", "sales")).toBeNull();
  });

  it("encodes the incoming slug", () => {
    expect(withWorkspaceSlug("/organizations/acme/workspaces/core", "a b")).toBe(
      "/organizations/acme/workspaces/a%20b",
    );
  });
});

describe("workspaceSlugFromPath", () => {
  it("reads the workspace a URL addresses", () => {
    expect(workspaceSlugFromPath("/organizations/acme/workspaces/sales/agents")).toBe("sales");
  });

  it("reads it from the workspace root too", () => {
    expect(workspaceSlugFromPath("/organizations/acme/workspaces/sales")).toBe("sales");
  });

  it("decodes the segment — the header carries the raw slug", () => {
    expect(workspaceSlugFromPath("/organizations/acme/workspaces/a%20b/memory")).toBe("a b");
  });

  it("returns null on an org-level path", () => {
    // No workspace named: the request goes unscoped and the caller's stored
    // preference resolves it server-side.
    expect(workspaceSlugFromPath("/organizations/acme/members")).toBeNull();
  });

  it("returns null on a deployment-level path", () => {
    expect(workspaceSlugFromPath("/settings")).toBeNull();
  });

  it("returns null rather than throwing on a malformed escape", () => {
    expect(workspaceSlugFromPath("/organizations/acme/workspaces/%E0%A4%A/x")).toBeNull();
  });

  it("round-trips with workspacePath", () => {
    expect(workspaceSlugFromPath(workspacePath("acme", "sales", "/agents"))).toBe("sales");
  });
});
