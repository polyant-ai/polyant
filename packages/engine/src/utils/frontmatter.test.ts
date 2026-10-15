// SPDX-License-Identifier: AGPL-3.0-or-later

import { normalizeRequiredEnv } from "./frontmatter.js";

// ---------------------------------------------------------------------------
// normalizeRequiredEnv
// ---------------------------------------------------------------------------
describe("normalizeRequiredEnv", () => {
  it("converts a string array to entries with sensitive=true", () => {
    const result = normalizeRequiredEnv(["API_KEY", "SECRET"]);
    expect(result).toEqual([
      { name: "API_KEY", sensitive: true },
      { name: "SECRET", sensitive: true },
    ]);
  });

  it("accepts an object array with name, description, and sensitive", () => {
    const result = normalizeRequiredEnv([
      { name: "DB_URL", description: "Database connection string", sensitive: true },
    ]);
    expect(result).toEqual([
      { name: "DB_URL", description: "Database connection string", sensitive: true },
    ]);
  });

  it("handles a mixed array of strings and objects", () => {
    const result = normalizeRequiredEnv([
      "TOKEN",
      { name: "HOST", description: "Hostname", sensitive: false },
    ]);
    expect(result).toEqual([
      { name: "TOKEN", sensitive: true },
      { name: "HOST", description: "Hostname", sensitive: false },
    ]);
  });

  it("returns an empty array for non-array input", () => {
    expect(normalizeRequiredEnv(null)).toEqual([]);
    expect(normalizeRequiredEnv(undefined)).toEqual([]);
    expect(normalizeRequiredEnv("string")).toEqual([]);
    expect(normalizeRequiredEnv(42)).toEqual([]);
    expect(normalizeRequiredEnv({})).toEqual([]);
  });

  it("filters out objects without a `name` property", () => {
    const result = normalizeRequiredEnv([
      { description: "no name here" },
      { name: "VALID" },
    ]);
    expect(result).toEqual([{ name: "VALID", sensitive: true }]);
  });

  it("defaults sensitive to true when not specified in an object", () => {
    const result = normalizeRequiredEnv([{ name: "KEY" }]);
    expect(result).toEqual([{ name: "KEY", sensitive: true }]);
  });

  it("preserves sensitive: false", () => {
    const result = normalizeRequiredEnv([{ name: "PUBLIC", sensitive: false }]);
    expect(result).toEqual([{ name: "PUBLIC", sensitive: false }]);
  });

  it("sets description to undefined when it is falsy", () => {
    const result = normalizeRequiredEnv([{ name: "X", description: "" }]);
    expect(result[0].name).toBe("X");
    expect(result[0].sensitive).toBe(true);
    expect(result[0].description).toBeUndefined();
  });

  it("coerces name to string via String()", () => {
    const result = normalizeRequiredEnv([{ name: 123 }]);
    expect(result).toEqual([{ name: "123", sensitive: true }]);
  });

  it("filters out non-string, non-object items (e.g. numbers, null)", () => {
    const result = normalizeRequiredEnv([null, 42, true, "VALID"]);
    expect(result).toEqual([{ name: "VALID", sensitive: true }]);
  });
});
