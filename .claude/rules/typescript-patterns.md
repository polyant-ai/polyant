---
description: "Enforce TypeScript backend patterns: Drizzle ORM, module organization, database conventions"
globs: ["**/*.ts"]
alwaysApply: true
---

# TypeScript Backend Patterns Rules

## MUST (violations block PR)

### Drizzle ORM
- Schema co-located with the domain: `modules/{feature}/schema.ts`, never inside a centralized `schema/` folder
- Primary key: `uuid('id').primaryKey().defaultRandom()` — always UUID, always auto-generated
- Timestamps: `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()` — `withTimezone: true` is mandatory
- JSONB: MUST use `.$type<T>()` with `.default({})` for type safety
- Indexes: defined as the third argument of `pgTable`, never as separate statements
- Column naming: database in `snake_case`, TypeScript in `camelCase`

### Module Organization
- Feature-based: `src/{feature}/` holds the domain — store, service, `{name}.schema.ts`,
  co-located tests. HTTP controllers live apart in `src/server/{area}/`: the NestJS bridge
  is the one deliberately layer-based directory. There is no `modules/` directory
- Never layer-based: no `controllers/`, `services/`, `schemas/` at the root
- Barrel exports: every module has an `index.ts` exposing the public interface

## SHOULD (warnings)

- Migration files AND their `meta/_journal.json` entry are written BY HAND. `drizzle-kit
  generate` emits a full-schema migration every time in this repo (no snapshot files), and
  a `00NN_*.sql` with no journal entry is silently skipped by `db:migrate` — which then
  reports success. See CLAUDE.md → Key Conventions for the `tag` / `when` rules
- Relations defined in `relations()` separate from the schema to avoid circular dependencies
- Transaction wrapper for multi-table operations
