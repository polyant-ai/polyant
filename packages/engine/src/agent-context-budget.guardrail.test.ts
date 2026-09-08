// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guardrail: the material loaded into EVERY agent turn has a budget.
 *
 * `CLAUDE.md` and `.claude/rules/*.md` are not documentation — they are prepended
 * to every request a coding agent makes against this repository. Their cost is paid
 * per turn, and instruction-following degrades as input grows: the rules that stop
 * being read first are the sharp specific ones, which is exactly what those files
 * are for.
 *
 * CLAUDE.md already carried a written rule that every addition must compress or
 * replace something. It had no enforcement, and the measured history is what that
 * produced: 32 KB in May 2026, 85 KB on 5 August, compressed to 24 KB on 28 August.
 * This test is that rule's enforcement, so the next climb stops at a red build
 * instead of at whoever notices.
 *
 * Hitting the cap is NOT a reason to raise the cap. It is the moment to move a
 * bullet's REASONING into `.claude/skills/backend-architecture/references/`, which
 * loads on demand, and leave the invariant behind. Raise the number only with a
 * deliberate, stated decision.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RULES_DIR = join(REPO_ROOT, ".claude", "rules");

/** Bytes. Measured 2026-09-08 after the housekeeping pass: 46 515. */
const ALWAYS_LOADED_BUDGET = 50_000;

function alwaysLoadedFiles(): string[] {
  // Derived from disk, never a hand-kept list: a rules file added tomorrow is paid
  // for on every turn whether or not anybody remembers to name it here.
  const rules = readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(RULES_DIR, f));
  return [join(REPO_ROOT, "CLAUDE.md"), ...rules];
}

describe("always-loaded agent context", () => {
  it("stays within its per-turn byte budget", () => {
    const files = alwaysLoadedFiles();

    // Non-vacuity floor: a moved directory or a changed glob must fail loudly
    // rather than turn this guardrail into a no-op that measures nothing.
    expect(files.length, "no always-loaded files found — did .claude/rules move?").toBeGreaterThan(5);

    const sizes = files.map((f) => ({ f: f.slice(REPO_ROOT.length + 1), bytes: statSync(f).size }));
    const total = sizes.reduce((n, s) => n + s.bytes, 0);

    const breakdown = sizes
      .sort((a, b) => b.bytes - a.bytes)
      .map((s) => `  ${String(s.bytes).padStart(6)}  ${s.f}`)
      .join("\n");

    expect(
      total,
      `Always-loaded agent context is ${total} bytes, over the ${ALWAYS_LOADED_BUDGET} budget.\n` +
        `Move a bullet's reasoning into .claude/skills/backend-architecture/references/ and\n` +
        `leave the invariant in CLAUDE.md. Do not raise the budget to make this pass.\n${breakdown}`,
    ).toBeLessThanOrEqual(ALWAYS_LOADED_BUDGET);
  });

  it("keeps every rules file readable, so the budget cannot be met by emptying one", () => {
    for (const f of alwaysLoadedFiles()) {
      expect(readFileSync(f, "utf-8").trim().length, `${f} is empty`).toBeGreaterThan(200);
    }
  });
});
