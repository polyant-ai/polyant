// SPDX-License-Identifier: AGPL-3.0-or-later

import { compareVersions, extractUnseenChangelogs } from "./version-compare";
import type { ChangelogEntry } from "./changelog-types";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
  });

  it("returns -1 when the first version is older", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
  });

  it("returns 1 when the first version is newer", () => {
    expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
  });

  it("compares by minor and patch, not just the leading digit", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
  });

  it("ignores a leading v prefix", () => {
    expect(compareVersions("v1.1.0", "1.0.0")).toBe(1);
  });
});

describe("extractUnseenChangelogs", () => {
  const entries: ChangelogEntry[] = [
    { version: "1.1.0", date: "2026-08-25", changes: [] },
    { version: "1.0.0", date: "2026-08-01", changes: [] },
    { version: "0.9.0", date: "2026-07-01", changes: [] },
  ];

  it("returns every entry, newest first, on first visit (no lastSeenVersion)", () => {
    const result = extractUnseenChangelogs(null, "1.1.0", entries);
    expect(result.map((e) => e.version)).toEqual(["1.1.0", "1.0.0", "0.9.0"]);
  });

  it("returns only entries newer than lastSeenVersion", () => {
    const result = extractUnseenChangelogs("1.0.0", "1.1.0", entries);
    expect(result.map((e) => e.version)).toEqual(["1.1.0"]);
  });

  it("returns nothing when lastSeenVersion is already current", () => {
    const result = extractUnseenChangelogs("1.1.0", "1.1.0", entries);
    expect(result).toEqual([]);
  });

  it("excludes entries newer than currentVersion", () => {
    const result = extractUnseenChangelogs(null, "1.0.0", entries);
    expect(result.map((e) => e.version)).toEqual(["1.0.0", "0.9.0"]);
  });
});
