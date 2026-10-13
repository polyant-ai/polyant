// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "vitest/config";
import { resolve } from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    /*
      Each test file still gets a fresh jsdom, but inside a VM context on a
      reused worker thread instead of a new process. Building jsdom per file
      was about half of the suite's wall time under the default `forks` pool.
      The trade-off is that a test cannot redefine non-configurable globals
      such as `window.location`: navigate with `history.pushState` and replace
      globals with `vi.stubGlobal`, which `unstubGlobals` undoes after each test.
    */
    pool: "vmThreads",
    unstubGlobals: true,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    /*
      A RATCHET, not a target.

      These floors sit about two points under what the suite actually covered
      across every file in `src` when they were set on 2026-10-13 (statements
      54.7, branches 50.6, functions 48.9, lines 55.7). They are not an aspiration:
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
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts", "src/test-setup.ts", "src/test-utils.tsx"],
      thresholds: { statements: 52, branches: 48, functions: 46, lines: 53 },
    },
  },
});
