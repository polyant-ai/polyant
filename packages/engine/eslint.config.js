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
    ignores: ["dist/", "node_modules/", "eslint-rules/**/*.test.js"],
  }
);
