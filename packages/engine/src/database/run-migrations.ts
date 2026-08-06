// SPDX-License-Identifier: AGPL-3.0-or-later

import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

/**
 * Advisory-lock key for the migration run. Arbitrary but fixed — any constant
 * works as long as every migrator agrees on it. Cast explicitly at the call
 * site: `pg_advisory_lock` is overloaded on (bigint) and (int, int), and an
 * uncast numeric parameter matches neither.
 */
const MIGRATION_LOCK_KEY = 8274119005471233;

/**
 * Apply pending migrations under a session-level advisory lock.
 *
 * The entrypoint runs a migrator before every container start, and drizzle's
 * migrator reads the last-applied row OUTSIDE a transaction: two replicas
 * starting together both see the same state and both apply the batch. Today's
 * migrations happen to survive that (IF NOT EXISTS, ON CONFLICT DO NOTHING, an
 * UPDATE scoped to the old value), but that is luck, not design — and it still
 * leaves duplicate rows in `drizzle.__drizzle_migrations`.
 *
 * The lock makes the loser WAIT and then find nothing to do, instead of racing.
 * Postgres releases it when the connection closes, so a crashed migrator cannot
 * wedge the next deploy.
 */
export async function runMigrationsLocked(
  sql: Sql,
  db: PostgresJsDatabase,
  migrationsFolder: string,
): Promise<void> {
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
  }
}
