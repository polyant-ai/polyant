// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every SUM of `ai_logs.estimated_cost_usd` accumulates in double precision.
 *
 * The column is `real` (4 bytes), and PostgreSQL sums a `real` in a `real`:
 * the cast that usually follows (`SUM(...)::float`) converts a total that has
 * already lost its precision. Measured on PostgreSQL 16, a million rows of
 * $0.000123 sum to 122.19 instead of 123.00, and the error grows with the row
 * count, so it is the dashboards over long periods that drift. Each row on its
 * own keeps ~7 significant digits, which is enough; only the accumulation is
 * wrong, and casting the operand (`SUM(estimated_cost_usd::float8)`) fixes it
 * without rewriting the largest table in the system.
 *
 * This test finds every SUM over the column in the engine's source and fails
 * when one sums the bare `real`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const COST_SUM = /SUM\(\s*(?:\w+\.)?estimated_cost_usd\b[^)]*\)/gi;
const DOUBLE = /::\s*(?:float8|double precision|numeric)/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("sums of ai_logs.estimated_cost_usd", () => {
  const sums = sourceFiles(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(COST_SUM)].map((m) => ({ file: relative(SRC, file), sql: m[0] })),
  );

  it("finds the analytics sums, so the scan is looking at real code", () => {
    expect(sums.map((s) => s.file)).toContain("analytics/analytics.store.ts");
  });

  it("casts the column before summing it, never after", () => {
    expect(sums.filter((s) => !DOUBLE.test(s.sql))).toEqual([]);
  });
});
