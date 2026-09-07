---
description: "Enforce TypeScript conventions: ESM, named exports, file naming, Zod config"
globs: ["**/*.ts", "**/*.tsx"]
alwaysApply: true
---

# TypeScript Style Rules

## MUST (violations block PR)

### ESM & Imports
- Relative VALUE imports: in `packages/engine` they MUST end in `.js` (Node ESM resolves
  no extension at runtime); in `packages/web` they MUST be EXTENSIONLESS (Next's bundler
  does not map `./x.js` onto `x.ts`, so a `.js` specifier passes tsc and vitest and fails
  `next build`). Type-only imports are erased and are correct either way — which is how a
  wrong `.js` gets copied from one into a value import unnoticed.
  *Enforced* by the ESLint rule `polyant/relative-import-extension`, registered in both
  packages with opposite `style` options, and auto-fixable. Before it existed nothing
  checked either direction: the engine's 1 928 compliant imports were compliant by habit,
  and the "no exceptions" wording this replaces is what put two `.js` imports into web
  test files, where they survive only because `next build` never compiles tests.
- Never use default exports. ALWAYS named exports for refactoring and tree-shaking.
- Import order: 1) node built-ins, 2) external packages, 3) internal modules, 4) relative

### File Naming
- ALL files in **kebab-case**: `user.schema.ts`, `user-profile.store.ts`
- Never camelCase or PascalCase for filenames
- Convention: `{entity}.{type}.ts` where type = `schema`, `service`, `controller`, `store`, `util`, `test`

### Configuration
- `process.env` MUST never be read directly in application code
- ALL env vars MUST be validated with Zod at startup: `safeParse()` + `process.exit(1)` on failure
- Centralized configuration in a single `config.ts` per module/service

### NestJS (where applicable)
- Controller = pure HTTP bridge. Zero business logic. Immediate delegation to a service.
- Service = business logic. Never accesses HTTP request/response directly.
- Module organization: feature-based, not layer-based

## SHOULD (warnings)

- Prefer exported functions over classes for stateless operations
- `strict: true` in `tsconfig.json` — includes `strictNullChecks`, `noImplicitAny`
- Avoid `any` — use `unknown` + type guards when the type is unknown
- Prefer `interface` for objects, `type` for union/utility types
