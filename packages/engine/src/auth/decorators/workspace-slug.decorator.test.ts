// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the `X-Workspace-Slug` param decorator.
 *
 * The header is CALLER-CONTROLLED — `packages/web` derives it from the URL in the
 * address bar — so the only jobs here are "read it" and "reject anything that is
 * not a slug". Deciding whether the caller may USE that workspace is
 * `resolveWorkspaceIdForPrincipal`'s job, tested separately; a decorator that
 * tried to authorize would be authorizing without a database.
 */

import { describe, it, expect } from "vitest";
import { parseWorkspaceSlugHeader as read } from "./workspace-slug.decorator.js";

describe("WorkspaceSlug decorator", () => {
  it("reads a well-formed slug", () => {
    expect(read("sandbox")).toBe("sandbox");
    expect(read("sales-eu-2")).toBe("sales-eu-2");
  });

  it("trims surrounding whitespace", () => {
    expect(read("  sandbox  ")).toBe("sandbox");
  });

  it("returns undefined when the header is absent", () => {
    expect(read(undefined)).toBeUndefined();
  });

  // Everything below must read as "not addressed" so the caller falls back to the
  // organization default, rather than reaching a query with junk in it.
  it.each([
    ["empty", ""],
    ["a path traversal", "../other"],
    ["a slash", "acme/general"],
    ["a percent escape", "%2e%2e"],
    ["a wildcard", "*"],
    ["a quote", "sandbox'"],
    ["a leading dash", "-sandbox"],
    ["uppercase", "Sandbox"],
    ["a SQL fragment", "x' OR '1'='1"],
    ["too long", "a".repeat(65)],
  ])("rejects %s", (_label, value) => {
    expect(read(value)).toBeUndefined();
  });

  it("rejects a non-string header value", () => {
    expect(read(42)).toBeUndefined();
    expect(read({})).toBeUndefined();
  });

  it("takes the first value when a header arrives repeated", () => {
    expect(read(["sandbox", "evil"])).toBe("sandbox");
  });
});
