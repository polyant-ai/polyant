// SPDX-License-Identifier: AGPL-3.0-or-later
// Ambient declarations for side-effect style imports (e.g. `import "./globals.css"`).
// TypeScript 6 is stricter about side-effect imports of non-code modules and
// requires an explicit module declaration (TS2882) where TS 5 was permissive.

declare module "*.css";
