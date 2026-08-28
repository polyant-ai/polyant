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
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
  },
});
