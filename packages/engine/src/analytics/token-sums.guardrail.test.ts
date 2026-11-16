// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * No SUM of an `ai_logs` token column is cast to a 4-byte integer.
 *
 * PostgreSQL sums an `integer` column into a `bigint`, and a trailing `::int`
 * turns that total back into an `integer`: once an organization's tokens over
 * the selected period pass 2,147,483,647, the whole query fails with
 * `integer out of range` (SQLSTATE 22003) and the dashboard answers 500. Long
 * cached prompts reach that total within a month. The sums are cast to
 * `float8` instead, which keeps them exact well past any realistic total and
 * reaches JavaScript as a number (a `bigint` would arrive as a string).
 *
 * This test finds every SUM over a `*_tokens` column in the engine's source and
 * fails when the line that holds it casts the result to `int`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_SUM_LINE = /^.*SUM\(\s*(?:\w+\.)?\w+_tokens\b.*$/gim;
const INT_CAST = /::\s*(?:int|integer|int4)\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("sums of ai_logs token columns", () => {
  const sums = sourceFiles(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(TOKEN_SUM_LINE)].map((m) => ({
      file: relative(SRC, file),
      sql: m[0].trim(),
    })),
  );

  it("finds the analytics sums, so the scan is looking at real code", () => {
    expect(sums.map((s) => s.file)).toContain("analytics/analytics.store.ts");
  });

  it("never casts a token total to a 4-byte integer", () => {
    expect(sums.filter((s) => INT_CAST.test(s.sql))).toEqual([]);
  });
});
