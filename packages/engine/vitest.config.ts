// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vitest/config";
import { resolve } from "path";

const require = createRequire(import.meta.url);

/*
  Tests load drizzle-orm from its CommonJS build. Node's ESM loader re-parses a
  package's whole `exports` map for every `.js` file it loads from it, and
  drizzle's map has about 450 entries for about 450 files: that made drizzle
  close to half of the unit tier's import time. Same package, same version;
  `vi.mock("drizzle-orm")` still applies because mocks and imports go through
  this resolver alike. Production keeps the ESM build and pays the cost once at
  boot.
*/
const drizzleCommonJs: Plugin = {
  name: "drizzle-orm-commonjs",
  enforce: "pre",
  resolveId(id) {
    if (id === "drizzle-orm" || id.startsWith("drizzle-orm/")) return require.resolve(id);
    return null;
  },
};

// `node_modules` and `dist` are vitest defaults, but naming them here means
// this list replaces the defaults rather than extending them, so they have
// to stay. `.claude/worktrees` is the one that matters: a git worktree lives
// INSIDE the repo, so a bare `vitest` run from the monorepo root collects
// every checked-out branch's copy of every test. That silently multiplies
// the suite and reports another branch's passes as this branch's — it hid a
// real failure here until the file paths in a verbose run gave it away.
const exclude = ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**", "**/.worktrees/**"];

export default defineConfig({
  plugins: [drizzleCommonJs],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.ts", "eslint-rules/**/*.test.js"],
          exclude: [...exclude, "**/*.integration.test.ts"],
          /*
            Files share worker threads, so node_modules packages load once per
            worker instead of once per file. test-file-reset.setup.ts must stay
            the FIRST setup file: it gives every file fresh engine modules, real
            timers and the initial env. Without it state leaks from one file to
            the next, and nothing fails at the moment it is removed. The
            test:unit script shuffles the file order and prints the seed, so a
            new leak shows up as a failure that --sequence.seed reproduces.
          */
          isolate: false,
          setupFiles: ["./src/test-file-reset.setup.ts", "./src/test-setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
          exclude,
          setupFiles: ["./src/test-setup.ts"],
        },
      },
    ],
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
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/test-setup.ts", "src/test-file-reset.setup.ts", "src/test-utils.ts", "src/database/test-db.ts"],
      thresholds: { statements: 71, branches: 64, functions: 68, lines: 72 },
    },
  },
});
