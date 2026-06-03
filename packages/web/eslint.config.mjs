// SPDX-License-Identifier: AGPL-3.0-or-later

import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // next-env.d.ts is a Next.js generated file (triple-slash refs, not meant to
    // be edited) — exclude it from lint.
    ignores: [".next/", "node_modules/", "dist/", "out/", "next-env.d.ts"],
  },
];

export default eslintConfig;
