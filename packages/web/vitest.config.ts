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
    include: ["**/*.test.ts", "**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
    css: false,
    /*
      A RATCHET, not a target.

      These floors sit about two points under what the suite actually covered
      when they were set on 2026-08-28 (statements 67.1, branches 61.6, functions 57.5, lines 68.7). They are not an aspiration:
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
      thresholds: { statements: 65, branches: 59, functions: 55, lines: 66 },
    },
  },
});
