// SPDX-License-Identifier: AGPL-3.0-or-later

import { orgPath, workspacePath, PLATFORM_PREFIX } from "./paths";

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
    expect(workspacePath("acme", "core", "/instances")).toBe(
      "/organizations/acme/workspaces/core/instances",
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
    expect(PLATFORM_PREFIX.startsWith("/organizations")).toBe(false);
  });
});
