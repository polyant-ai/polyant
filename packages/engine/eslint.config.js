// SPDX-License-Identifier: AGPL-3.0-or-later

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
      // One way to read a caught value's message: errMsg() in utils/error.ts.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][consequent.property.name='message'][alternate.callee.name='String']",
          message: "Use errMsg(err) from utils/error.ts instead of `err instanceof Error ? err.message : String(err)`.",
        },
      ],
    },
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
