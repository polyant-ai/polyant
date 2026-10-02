// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * drizzle.config.ts lists the schema files by hand, and the list had fallen
 * about six files behind the tree: drizzle-kit then saw a database with tables
 * it did not know (and `push` would have dropped them). The subjects are the
 * files under src/ that declare a table, found by reading the tree.
 */
const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ENGINE_ROOT, "src");

function filesDeclaringTables(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .filter((f) => /\bpgTable\(/.test(readFileSync(join(SRC, f), "utf8")))
    .map((f) => `./${relative(ENGINE_ROOT, join(SRC, f))}`)
    .sort();
}

describe("drizzle.config.ts schema list", () => {
  it("names every source file that declares a table, and nothing else", () => {
    const config = readFileSync(join(ENGINE_ROOT, "drizzle.config.ts"), "utf8");
    const listed = [...config.matchAll(/"(\.\/src\/[^"]+\.ts)"/g)].map((m) => m[1]).sort();
    const declared = filesDeclaringTables();

    expect(declared.length).toBeGreaterThan(0);
    expect(listed).toEqual(declared);
  });
});
