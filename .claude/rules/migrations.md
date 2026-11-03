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
- Verify migration-journal tests and the affected store/query tests before completion.
