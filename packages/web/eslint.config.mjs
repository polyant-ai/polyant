// SPDX-License-Identifier: AGPL-3.0-or-later

// eslint-config-next 16 ships native flat config (ESLint 9) and drops `next lint`.
// The old FlatCompat.extends("next/...") bridge no longer works with v16 (it
// serialises the shareable config and hits a circular structure). Import the
// flat presets directly and run via the ESLint CLI (`eslint .`).
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";
// Shared with the engine, which runs it in the OPPOSITE direction. Here a
// relative value import must be EXTENSIONLESS: Next's bundler does not map
// `./x.js` onto `x.ts`, so such an import type-checks, passes vitest and fails
// `next build` with module-not-found.
import relativeImportExtension from "../engine/eslint-rules/relative-import-extension.js";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // eslint-config-next 16 adds/tightens these rules (react-compiler family +
      // stricter defaults). The app code is unchanged from when it passed lint
      // under eslint-config-next 15, so for this upgrade they are kept as
      // warnings and addressed in a dedicated follow-up rather than blocking.
      "@typescript-eslint/no-unused-vars": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "@next/next/no-img-element": "warn",
      "polyant/relative-import-extension": ["error", { style: "extensionless" }],
    },
    plugins: { polyant: { rules: { "relative-import-extension": relativeImportExtension } } },
  },
  {
    // next-env.d.ts is a Next.js generated file (triple-slash refs, not meant to
    // be edited) — exclude it from lint. The e2e harness (Playwright/Node, not
    // React/Next) has its own tsconfig and is linted separately if at all.
    ignores: [
      ".next/",
      ".next-e2e/",
      "node_modules/",
      "dist/",
      "out/",
      "next-env.d.ts",
      "e2e/",
      "playwright.config.ts",
      "test-results/",
      "playwright-report/",
    ],
  },
];

export default eslintConfig;
