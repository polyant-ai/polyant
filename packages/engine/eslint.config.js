// SPDX-License-Identifier: GPL-3.0-or-later

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import requireInject from "./eslint-rules/require-inject-in-nest-classes.js";
import relativeImportExtension from "./eslint-rules/relative-import-extension.js";

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
    plugins: {
      polyant: {
        rules: {
          "require-inject-in-nest-classes": requireInject,
          "relative-import-extension": relativeImportExtension,
        },
      },
    },
    rules: {
      "polyant/require-inject-in-nest-classes": "error",
      // Node ESM: an extensionless relative import type-checks (moduleResolution
      // "bundler"), lints, tests and builds — then throws ERR_MODULE_NOT_FOUND on
      // `node dist/index.js`. Nothing checked either direction before this rule.
      "polyant/relative-import-extension": ["error", { style: "js" }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "eslint-rules/**/*.test.js"],
  }
);
