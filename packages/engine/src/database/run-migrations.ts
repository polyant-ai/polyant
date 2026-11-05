// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** How often a migrator that found another one running asks for the lock again. */
const MIGRATION_LOCK_POLL_MS = 1_000;

/**
 * Waits before a migration that gave up on a table lock is tried again. Four
 * retries: a query that holds a table for longer than that is better met by an
 * operator than by a deploy that keeps queueing behind it.
 */
export const LOCK_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

/** Default `lock_timeout` of a transactional migration. */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000;

const NOT_READY_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "CONNECT_TIMEOUT"]);

/** SQLSTATE of a statement that gave up waiting for a lock (`lock_timeout`). */
const LOCK_NOT_AVAILABLE = "55P03";

/** Connection errors that mean "not up yet", as opposed to auth or SQL errors. */
export function isConnectionNotReadyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_READY_CODES.has(code);
}

type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Block until the database accepts a connection, retrying with backoff only on
 * connection-refused / DNS / timeout errors. Anything else (bad password, bad
 * database) fails at once, since waiting cannot fix it.
 */
export async function waitForDatabase(sql: Sql, opts: { sleep?: Sleep } = {}): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
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

/** One journal entry with its SQL, as the runner applies it. */
export interface Migration {
  tag: string;
  /** The journal's `when`, stored as `created_at`: the watermark the runner resumes from. */
  when: number;
  /** sha256 of the file, as drizzle-orm's migrator records it. */
  hash: string;
  /** The file split on `--> statement-breakpoint`, each part sent as one query. */
  statements: string[];
  /** Only concurrent index statements: applied one by one, outside a transaction. */
  concurrent: boolean;
}

const BREAKPOINT = "--> statement-breakpoint";
const INDEX_NAME = String.raw`("(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const CONCURRENT_START = /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY\b/i;
const CONCURRENT_CREATE = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+${INDEX_NAME}\s+ON\s`, "i");
const CONCURRENT_DROP = new RegExp(String.raw`^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+${INDEX_NAME}$`, "i");

/** A statement without its line comments and its final semicolon: what decides how it runs. */
function codeOf(statement: string): string {
  return statement.replace(/--[^\n]*/g, "").trim().replace(/;$/, "").trim();
}

/**
 * Whether a migration runs outside a transaction, decided by its content: it
 * does when its statements are `CREATE INDEX CONCURRENTLY IF NOT EXISTS` or
 * `DROP INDEX CONCURRENTLY IF EXISTS`, one per breakpoint. Postgres refuses
 * either inside a transaction, so a file that mixes them with anything else, or
 * puts two in one part, could never apply; it is rejected before anything runs.
 */
function classify(tag: string, statements: string[]): boolean {
  const code = statements.map(codeOf).filter((c) => c !== "");
  if (!code.some((c) => CONCURRENT_START.test(c))) return false;
  for (const c of code) {
    if (!c.includes(";") && (CONCURRENT_CREATE.test(c) || CONCURRENT_DROP.test(c))) continue;
    throw new Error(
      `Migration ${tag} mixes concurrent index statements with other SQL. A concurrent migration holds only ` +
        "`CREATE INDEX CONCURRENTLY IF NOT EXISTS` / `DROP INDEX CONCURRENTLY IF EXISTS` statements, " +
        `one per \`${BREAKPOINT}\`. Offending part: ${c.slice(0, 120)}`,
    );
  }
  return true;
}

/**
 * Read the journal and the SQL files the way drizzle-orm's `readMigrationFiles`
 * does (same order, same split, same hash), so the rows this runner writes are
 * the ones drizzle wrote.
 */
export function readMigrations(migrationsFolder: string): Migration[] {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  return journal.entries.map(({ tag, when }) => {
    const query = readFileSync(join(migrationsFolder, `${tag}.sql`)).toString();
    const statements = query.split(BREAKPOINT);
    return {
      tag,
      when,
      hash: createHash("sha256").update(query).digest("hex"),
      statements,
      concurrent: classify(tag, statements),
    };
  });
}

export interface RunMigrationsOptions {
  /** `lock_timeout` of each transactional migration. */
  lockTimeoutMs?: number;
  /** Waits between attempts of a migration that met `lock_timeout`. */
  lockRetryDelaysMs?: readonly number[];
  /** Schema of the bookkeeping table; tests use their own. */
  migrationsSchema?: string;
  sleep?: Sleep;
}

/**
 * Apply pending migrations, each in its own transaction, under a session-level
 * advisory lock.
 *
 * The bookkeeping is drizzle-orm's: one row per applied migration in
 * `<schema>.__drizzle_migrations` with the file's sha256 and the journal's
 * `when`, and a migration is pending when its `when` is above the newest
 * `created_at` there. A database migrated by drizzle's migrator continues here
 * from where it stopped.
 *
 * Drizzle applied the whole pending batch in ONE transaction, so the first
 * `ALTER TABLE` of a release held its table's ACCESS EXCLUSIVE lock until the
 * last index of the batch was built, and every turn of a replica still serving
 * the previous release waited that long. Here a lock lasts as long as the
 * migration that takes it. Each transactional migration runs with a short
 * `lock_timeout`: an `ALTER` queued behind a long query gives up and is tried
 * again a little later, instead of holding up every query that arrives after it.
 *
 * A migration of concurrent index statements runs outside a transaction (see
 * `classify`). A concurrent build that failed leaves an INVALID index behind,
 * which `IF NOT EXISTS` would keep; it is dropped and built again.
 *
 * A failed migration stops the run: the ones before it stay applied, and the
 * error names the one that failed.
 *
 * The advisory lock makes a second migrator WAIT and then find nothing to do,
 * instead of racing. It asks with `pg_try_advisory_lock` between pauses rather
 * than blocking in `pg_advisory_lock`: a blocked call is a running statement
 * holding a snapshot, which a concurrent index build waits for, while the
 * build's migrator holds the lock the call waits for. Postgres releases the lock
 * when the connection closes, so a crashed migrator cannot wedge the next deploy.
 */
export async function runMigrationsLocked(
  sql: Sql,
  migrationsFolder: string,
  opts: RunMigrationsOptions = {},
): Promise<void> {
  const migrations = readMigrations(migrationsFolder);
  const sleep = opts.sleep ?? realSleep;
  await waitForDatabase(sql, { sleep });
  // One connection for the lock, the bookkeeping and every migration: the lock
  // belongs to the session that took it.
  const conn = await sql.reserve();
  try {
    for (;;) {
      const [row] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) AS locked`;
      if (row?.locked) break;
      log.info("migrations", "Another migrator is running, waiting for it to finish...");
      await sleep(MIGRATION_LOCK_POLL_MS);
    }
    try {
      await applyPending(conn, migrations, opts, sleep);
    } finally {
      await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    }
  } finally {
    conn.release();
  }
}

async function applyPending(
  conn: Sql,
  migrations: Migration[],
  opts: RunMigrationsOptions,
  sleep: Sleep,
): Promise<void> {
  const schema = conn(opts.migrationsSchema ?? "drizzle");
  await conn`CREATE SCHEMA IF NOT EXISTS ${schema}`;
  await conn`CREATE TABLE IF NOT EXISTS ${schema}.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )`;
  const [last] = await conn<{ created_at: string | null }[]>`
    SELECT created_at FROM ${schema}.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
  const watermark = last ? Number(last.created_at) : undefined;

  for (const migration of migrations) {
    if (watermark !== undefined && watermark >= migration.when) continue;
    const record = () =>
      conn`INSERT INTO ${schema}.__drizzle_migrations (hash, created_at) VALUES (${migration.hash}, ${migration.when})`;
    try {
      if (migration.concurrent) await applyConcurrent(conn, migration, record);
      else await applyInTransaction(conn, migration, record, opts, sleep);
    } catch (err) {
      throw new Error(`Migration ${migration.tag} failed: ${describeMigrationError(err).message}`, { cause: err });
    }
  }
}

async function applyInTransaction(
  conn: Sql,
  migration: Migration,
  record: () => Promise<unknown>,
  opts: RunMigrationsOptions,
  sleep: Sleep,
): Promise<void> {
  const lockTimeoutMs = Math.trunc(opts.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
  const delays = opts.lockRetryDelaysMs ?? LOCK_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    await conn.unsafe("BEGIN");
    try {
      await conn.unsafe(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      for (const statement of migration.statements) {
        if (codeOf(statement) !== "") await conn.unsafe(statement);
      }
      await record();
      await conn.unsafe("COMMIT");
      return;
    } catch (err) {
      // The original error says what went wrong; a failed ROLLBACK (the
      // connection is gone) would only hide it.
      await conn.unsafe("ROLLBACK").catch(() => undefined);
      const delay = delays[attempt];
      if ((err as { code?: unknown }).code !== LOCK_NOT_AVAILABLE || delay === undefined) throw err;
      log.warn("migrations", `${migration.tag} waited ${lockTimeoutMs} ms for a table lock, retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
}

async function applyConcurrent(conn: Sql, migration: Migration, record: () => Promise<unknown>): Promise<void> {
  for (const statement of migration.statements) {
    const code = codeOf(statement);
    if (code === "") continue;
    const index = CONCURRENT_CREATE.exec(code)?.[1];
    if (index) {
      const [found] = await conn<{ valid: boolean }[]>`
        SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(${index})`;
      if (found && !found.valid) {
        log.warn("migrations", `${migration.tag}: index ${index} was left invalid by an earlier attempt, building it again`);
        await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);
      }
    }
    await conn.unsafe(code);
  }
  await record();
}
