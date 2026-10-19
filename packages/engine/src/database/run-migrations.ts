// SPDX-License-Identifier: AGPL-3.0-or-later

import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { createLogger } from "../utils/create-logger.js";

const log = createLogger();

/**
 * Advisory-lock key for the migration run. Arbitrary but fixed — any constant
 * works as long as every migrator agrees on it. Cast explicitly at the call
 * site: `pg_advisory_lock` is overloaded on (bigint) and (int, int), and an
 * uncast numeric parameter matches neither.
 */
const MIGRATION_LOCK_KEY = 8274119005471233;

/**
 * Waits between connection attempts: about 60 s in total, long enough for a
 * Postgres container that starts alongside the engine, short enough that a
 * wrong host still fails the deploy.
 */
export const CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];

const NOT_READY_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "CONNECT_TIMEOUT"]);

/** Connection errors that mean "not up yet", as opposed to auth or SQL errors. */
export function isConnectionNotReadyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_READY_CODES.has(code);
}

/**
 * Block until the database accepts a connection, retrying with backoff only on
 * connection-refused / DNS / timeout errors. Anything else (bad password, bad
 * database) fails at once, since waiting cannot fix it.
 */
export async function waitForDatabase(
  sql: Sql,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      const delay = CONNECT_RETRY_DELAYS_MS[attempt];
      if (!isConnectionNotReadyError(err) || delay === undefined) throw err;
      log.warn("migrations", `Database not reachable yet, retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
}

/**
 * Turn the Postgres "permission denied to create extension" failure of
 * migration 0000 into an instruction. pgvector is not a trusted extension on
 * every distribution, so a normal application user cannot create it.
 */
export function describeMigrationError(err: unknown): Error {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (code === "42501" && typeof message === "string" && /create extension/i.test(message)) {
      return new Error(
        "The database user is not allowed to create the pgvector extension. " +
          "Connect to the target database as a superuser and run `CREATE EXTENSION vector;` once, " +
          "then start the engine again.",
        { cause: err },
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

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
  await waitForDatabase(sql);
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    throw describeMigrationError(err);
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
  }
}
