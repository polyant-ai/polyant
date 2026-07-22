// SPDX-License-Identifier: AGPL-3.0-or-later

import { isNavActive } from "./nav-main";

describe("isNavActive", () => {
  it("does not activate a prefix-string sibling (/audit vs /audit-logs)", () => {
    // The reported bug: clicking Tool Traces lit up Audit too.
    expect(isNavActive("/audit-logs", "/audit")).toBe(false);
    expect(isNavActive("/audit-logs", "/audit-logs")).toBe(true);
  });

  it("activates the exact route and its sub-routes", () => {
    expect(isNavActive("/audit-logs", "/audit-logs")).toBe(true);
    expect(isNavActive("/audit-logs/123", "/audit-logs")).toBe(true);
  });

  it("matches the dashboard only on the exact root path", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/instances", "/")).toBe(false);
  });
});
