---
paths:
  - "packages/engine/src/database/migrations/**"
  - "packages/engine/src/**/schema.ts"
  - "packages/engine/src/**/*.schema.ts"
---

# Database migrations

- Treat schema changes and migrations as one change. Update the SQL migration and
  `meta/_journal.json` together.
- Choose the next number from the directory; do not reuse or reorder an applied migration.
- Journal `tag` equals the SQL filename without `.sql`; `when` is greater than every prior
  entry.
- A schema-file change also rewrites the snapshot in `meta/` (`npm run db:snapshot`).
  `db:generate` names its file after the journal length: rename it to the next number and
  fix the `tag`.
- Add indexes required by the access path, especially for foreign keys and tenant filters.
- The runner (`database/run-migrations.ts`) applies each migration in its own transaction,
  with a short `lock_timeout` and a few retries. Keep a migration that alters a large or
  busy table to catalog-only changes (no table rewrite, no backfill under ACCESS EXCLUSIVE).
- One migration alters at most one hot table and never backfills a hot table it alters;
  `HOT_TABLES` in `database/migration-journal.test.ts` is the list, and that test enforces it.
- An index on a table that already holds data goes in a migration of its own, written
  `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS "name" ON ...` or
  `DROP INDEX CONCURRENTLY IF EXISTS "name"`, one statement per `--> statement-breakpoint`.
  The runner reads the content: a file of only those statements runs outside a transaction,
  and an index left INVALID by a failed build is dropped and built again. A file that mixes
  them with other SQL is rejected before anything runs.
- The runner decides by `when` alone, never by hash: editing an applied migration does not
  rerun it. A fix to applied logic is a new, idempotent migration.
- Verify migration-journal tests and the affected store/query tests before completion.
