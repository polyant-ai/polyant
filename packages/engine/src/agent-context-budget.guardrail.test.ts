// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RULES_DIR = join(REPO_ROOT, ".claude", "rules");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");
const ALWAYS_LOADED_BUDGET = 25_000;
const INSTRUCTION_LINE_BUDGET = 200;

function content(path: string): string {
  return readFileSync(path, "utf8");
}

function hasPathScope(path: string): boolean {
  const frontmatter = content(path).match(/^---\n([\s\S]*?)\n---/);
  return frontmatter?.[1].split("\n").some((line) => /^paths:\s*$/.test(line)) ?? false;
}

/** CLAUDE.md and every file it pulls in through an `@<path>` line, recursively. */
function instructionFiles(file = CLAUDE_MD, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const imports = content(file)
    .split("\n")
    .map((line) => line.match(/^@(\S+)\s*$/)?.[1])
    .filter((target): target is string => target !== undefined)
    .map((target) => resolve(dirname(file), target));
  return [file, ...imports.flatMap((target) => instructionFiles(target, seen))];
}

function alwaysLoadedFiles(): string[] {
  const unscopedRules = readdirSync(RULES_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => join(RULES_DIR, file))
    .filter((file) => !hasPathScope(file));

  return [...instructionFiles(), ...unscopedRules];
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

    const instructions = instructionFiles();
    expect(instructions.length, "CLAUDE.md imports no instruction file").toBeGreaterThan(1);
    const lines = instructions.reduce((sum, file) => sum + content(file).split("\n").length, 0);
    expect(lines, instructions.map((file) => file.slice(REPO_ROOT.length + 1)).join("\n")).toBeLessThanOrEqual(
      INSTRUCTION_LINE_BUDGET,
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
