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

      These floors sit about two points under what the suite actually covered
      when they were set on 2026-08-28 (statements 67.2, branches 60.3, functions 64.3, lines 68.8). They are not an aspiration:
      their only job is to stop a PR from LOWERING coverage. The buffer exists so
      a refactor that legitimately deletes covered code does not fail the build.

      `.claude/rules/testing.md` claimed 80%, and 100% on critical paths. Nobody
      had ever measured it and no job checked it — the real number was 67% of
      statements, so that rule was not a missed goal, it was a number with
      nothing behind it. Raising these floors is a deliberate act taken with a
      measurement in hand, not something inherited from a document.

      Enforced only when coverage is requested (CI passes --coverage), so a local
      `npm run test:unit` stays fast.
    */
    coverage: {
      thresholds: { statements: 65, branches: 58, functions: 62, lines: 66 },
    },
  },
});
