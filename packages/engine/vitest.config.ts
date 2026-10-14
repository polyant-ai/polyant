// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    setupFiles: ["./src/test-setup.ts"],
    include: ["**/*.test.ts", "**/*.integration.test.ts", "eslint-rules/**/*.test.js"],
    // `node_modules` and `dist` are vitest defaults, but naming them here means
    // this list replaces the defaults rather than extending them, so they have
    // to stay. `.claude/worktrees` is the one that matters: a git worktree lives
    // INSIDE the repo, so a bare `vitest` run from the monorepo root collects
    // every checked-out branch's copy of every test. That silently multiplies
    // the suite and reports another branch's passes as this branch's — it hid a
    // real failure here until the file paths in a verbose run gave it away.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**", "**/.worktrees/**"],
    /*
      A RATCHET, not a target.

      These floors sit about two points under what the unit tier actually
      covered when they were last set, on 2026-10-14 (statements 73.09,
      branches 66.68, functions 69.99, lines 74.85, measured with
      `npm run test:unit -- --coverage` over every source file). They are not an aspiration:
      their only job is to stop a PR from LOWERING coverage. The buffer exists so
      a refactor that legitimately deletes covered code does not fail the build.

      Raising these floors is a deliberate act taken with a measurement in hand,
      not something inherited from prose.

      Enforced only when coverage is requested (CI passes --coverage), so a local
      `npm run test:unit` stays fast.
    */
    coverage: {
      // Measure every source file, not only the ones a test happens to import:
      // an untested module must count against the total instead of vanishing
      // from it.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/test-setup.ts", "src/test-utils.ts", "src/database/test-db.ts"],
      thresholds: { statements: 71, branches: 64, functions: 68, lines: 72 },
    },
  },
});
