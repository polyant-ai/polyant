// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A scripted edit once inserted imports above the SPDX line of a source file.
 * License scanners read the top of the file, so the line has to stay within
 * the first three lines. Files without an SPDX line are out of scope here.
 */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "../..");

function misplacedHeaders(): string[] {
  const bad: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    let entries: string[];
    try {
      entries = readdirSync(src, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const f of entries.filter((e) => /\.(ts|tsx)$/.test(e))) {
      const lines = readFileSync(join(src, f), "utf8").split("\n");
      const at = lines.findIndex((l) => l.includes("SPDX-License-Identifier"));
      if (at >= 3) bad.push(`${relative(PACKAGES, join(src, f))}:${at + 1}`);
    }
  }
  return bad;
}

describe("SPDX header position", () => {
  it("keeps the SPDX-License-Identifier line within the first three lines", () => {
    expect(misplacedHeaders()).toEqual([]);
  });
});
