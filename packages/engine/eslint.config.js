// SPDX-License-Identifier: GPL-3.0-or-later

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import requireInject from "./eslint-rules/require-inject-in-nest-classes.js";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: { polyant: { rules: { "require-inject-in-nest-classes": requireInject } } },
    rules: { "polyant/require-inject-in-nest-classes": "error" },
  },
  {
    // Plain-JS scripts under scripts/ run on Node directly, so `no-undef` needs
    // to know about the Node globals it would otherwise flag. Kept narrow on
    // purpose: src/ is TypeScript and gets its globals from @types/node.
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  {
    ignores: ["dist/", "node_modules/", "eslint-rules/**/*.test.js"],
  }
);
