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
    include: ["**/*.test.ts", "**/*.integration.test.ts", "**/*.functional.test.ts", "eslint-rules/**/*.test.js"],
  },
});
