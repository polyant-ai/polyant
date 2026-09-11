// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RULES_DIR = join(REPO_ROOT, ".claude", "rules");
const ALWAYS_LOADED_BUDGET = 25_000;
const CLAUDE_LINE_BUDGET = 200;

function content(path: string): string {
  return readFileSync(path, "utf8");
}

function hasPathScope(path: string): boolean {
  const frontmatter = content(path).match(/^---\n([\s\S]*?)\n---/);
  return frontmatter?.[1].split("\n").some((line) => /^paths:\s*$/.test(line)) ?? false;
}

function alwaysLoadedFiles(): string[] {
  const unscopedRules = readdirSync(RULES_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => join(RULES_DIR, file))
    .filter((file) => !hasPathScope(file));

  return [join(REPO_ROOT, "CLAUDE.md"), ...unscopedRules];
}

describe("agent instruction context", () => {
  it("keeps the startup payload within its byte and line budgets", () => {
    const files = alwaysLoadedFiles();
    const sizes = files.map((file) => ({
      file: file.slice(REPO_ROOT.length + 1),
      bytes: statSync(file).size,
    }));
    const total = sizes.reduce((sum, item) => sum + item.bytes, 0);
    const breakdown = sizes.map(({ file, bytes }) => `${bytes} ${file}`).join("\n");

    expect(total, breakdown).toBeLessThanOrEqual(ALWAYS_LOADED_BUDGET);
    expect(content(join(REPO_ROOT, "CLAUDE.md")).split("\n").length).toBeLessThanOrEqual(
      CLAUDE_LINE_BUDGET,
    );
  });

  it("keeps every project rule path-scoped", () => {
    const rules = readdirSync(RULES_DIR)
      .filter((file) => file.endsWith(".md"))
      .map((file) => join(RULES_DIR, file));

    expect(rules.length, "no project rules found").toBeGreaterThan(0);
    expect(rules.filter((file) => !hasPathScope(file))).toEqual([]);
  });
});
