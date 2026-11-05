// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The migration runner against a real Postgres: what it records, where it
 * stops, how it treats an index a failed concurrent build left behind, and how
 * it gives way to a query that holds a table.
 *
 * Every test works in a schema of its own, bookkeeping table included, so the
 * test database's own migration history is never touched.
 *
 * Self-skips without a database.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { config } from "../config.js";
import { resolveDatabaseAvailability } from "./test-db.js";
import { runMigrationsLocked } from "./run-migrations.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const clients: Sql[] = [];
const schemas: string[] = [];

function connect(searchPath?: string): Sql {
  const sql = postgres(config.postgres.databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    ...(searchPath ? { connection: { search_path: searchPath } } : {}),
  });
  clients.push(sql);
  return sql;
}

/** A schema for one test; `S` in a migration's SQL stands for its name. */
function newSchema(): string {
  const name = `mig_t_${randomBytes(4).toString("hex")}`;
  schemas.push(name);
  return name;
}

/** A migrations folder holding the given files, in journal order. */
function folderWith(schema: string, files: Array<[tag: string, sql: string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  mkdirSync(join(dir, "meta"));
  const entries = files.map(([tag], idx) => ({ idx, version: "7", when: 1_000 + idx, tag, breakpoints: true }));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  for (const [tag, sql] of files) writeFileSync(join(dir, `${tag}.sql`), sql.replaceAll("S.", `"${schema}".`));
  return dir;
}

async function recorded(sql: Sql, schema: string): Promise<Array<{ hash: string; created_at: string }>> {
  return sql`SELECT hash, created_at FROM ${sql(schema)}.__drizzle_migrations ORDER BY id`;
}

const noSleep = async () => {};

afterEach(async () => {
  const admin = clients[0];
  if (admin) for (const schema of schemas.splice(0)) await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
  for (const sql of clients.splice(0)) await sql.end();
});

describe.skipIf(!DB_AVAILABLE)("runMigrationsLocked", () => {
  it("writes the rows drizzle's migrator writes, resumes where drizzle stopped, and a second run adds none", async () => {
    const sql = connect();
    const ours = newSchema();
    const theirs = newSchema();
    const resumed = newSchema();
    // Statements that leave nothing behind, so every run applies the same files.
    const files: Array<[string, string]> = [
      ["0000_a", "SELECT 1;\n--> statement-breakpoint\nSELECT 2;\n"],
      ["0001_b", "-- a comment\nSELECT 3;\n"],
    ];
    const folder = folderWith(ours, files);

    await migrate(drizzle(sql), { migrationsFolder: folder, migrationsSchema: theirs });
    await runMigrationsLocked(sql, folder, { migrationsSchema: ours, sleep: noSleep });
    await runMigrationsLocked(sql, folder, { migrationsSchema: ours, sleep: noSleep });
    expect(await recorded(sql, ours)).toEqual(await recorded(sql, theirs));
    expect(await recorded(sql, ours)).toHaveLength(2);

    await migrate(drizzle(sql), { migrationsFolder: folderWith(resumed, files.slice(0, 1)), migrationsSchema: resumed });
    await runMigrationsLocked(sql, folder, { migrationsSchema: resumed, sleep: noSleep });
    expect(await recorded(sql, resumed)).toEqual(await recorded(sql, theirs));
  });

  it("stops at a failing migration, keeps the ones before it and names it", async () => {
    const sql = connect();
    const schema = newSchema();
    await sql`CREATE SCHEMA ${sql(schema)}`;
    const folder = folderWith(schema, [
      ["0000_ok", 'CREATE TABLE S."kept" ("id" int);'],
      ["0001_broken", 'CREATE TABLE S."half" ("id" int);\nALTER TABLE S."missing" ADD COLUMN "x" int;'],
      ["0002_after", 'CREATE TABLE S."never" ("id" int);'],
    ]);

    await expect(runMigrationsLocked(sql, folder, { migrationsSchema: schema, sleep: noSleep })).rejects.toThrow(
      /^Migration 0001_broken failed: .*missing/,
    );

    const tables = await sql<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ${schema} ORDER BY 1`;
    expect(tables.map((r) => r.t)).toEqual(["__drizzle_migrations", "kept"]);
    expect(await recorded(sql, schema)).toHaveLength(1);
  });

  it("builds again an index that a failed concurrent build left invalid", async () => {
    const schema = newSchema();
    // The index name in the migration is unqualified, as in the real ones: it
    // resolves through the search path.
    const sql = connect(schema);
    await sql`CREATE SCHEMA ${sql(schema)}`;
    await sql`CREATE TABLE ${sql(schema)}."t" ("a" int)`;
    await sql`INSERT INTO ${sql(schema)}."t" VALUES (1), (1)`;
    const folder = folderWith(schema, [
      ["0000_unique", 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "t_a" ON S."t" ("a");'],
    ]);
    const valid = async () =>
      (await sql<{ v: boolean }[]>`SELECT indisvalid AS v FROM pg_index WHERE indexrelid = to_regclass(${`"${schema}"."t_a"`})`)[0]?.v;

    await expect(runMigrationsLocked(sql, folder, { migrationsSchema: schema, sleep: noSleep })).rejects.toThrow(
      /^Migration 0000_unique failed/,
    );
    expect(await valid()).toBe(false);
    expect(await recorded(sql, schema)).toHaveLength(0);

    await sql`DELETE FROM ${sql(schema)}."t" WHERE ctid = (SELECT max(ctid) FROM ${sql(schema)}."t")`;
    await runMigrationsLocked(sql, folder, { migrationsSchema: schema, sleep: noSleep });
    expect(await valid()).toBe(true);
    expect(await recorded(sql, schema)).toHaveLength(1);
  });

  it("gives up on a held table after lock_timeout and applies the migration once the table is free", async () => {
    const sql = connect();
    const holder = connect();
    const schema = newSchema();
    await sql`CREATE SCHEMA ${sql(schema)}`;
    await sql`CREATE TABLE ${sql(schema)}."busy" ("id" int)`;
    const folder = folderWith(schema, [["0000_alter", 'ALTER TABLE S."busy" ADD COLUMN "x" int;']]);

    // A long read holds the table: the ALTER queues behind it.
    const holding = await holder.reserve();
    await holding`BEGIN`;
    await holding`SELECT * FROM ${holding(schema)}."busy"`;

    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      if (waits.length === 2) {
        await holding`COMMIT`;
        holding.release();
      }
    };
    const started = Date.now();
    await runMigrationsLocked(sql, folder, {
      migrationsSchema: schema,
      lockTimeoutMs: 200,
      lockRetryDelaysMs: [10, 20, 40],
      sleep,
    });

    expect(waits).toEqual([10, 20]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    const cols = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = ${schema} AND column_name = 'x'`;
    expect(cols).toHaveLength(1);
  });

  it("fails naming the migration when the table stays held past every retry", async () => {
    const sql = connect();
    const holder = connect();
    const schema = newSchema();
    await sql`CREATE SCHEMA ${sql(schema)}`;
    await sql`CREATE TABLE ${sql(schema)}."busy" ("id" int)`;
    const folder = folderWith(schema, [["0000_alter", 'ALTER TABLE S."busy" ADD COLUMN "x" int;']]);
    const holding = await holder.reserve();
    await holding`BEGIN`;
    await holding`SELECT * FROM ${holding(schema)}."busy"`;

    try {
      const run = runMigrationsLocked(sql, folder, {
        migrationsSchema: schema,
        lockTimeoutMs: 100,
        lockRetryDelaysMs: [10],
        sleep: noSleep,
      });
      await expect(run).rejects.toThrow(/^Migration 0000_alter failed: .*lock timeout/);
      await expect(run).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally {
      await holding`COMMIT`;
      holding.release();
    }
    expect(await recorded(sql, schema)).toHaveLength(0);
  });

  it("lets a second migrator wait for a concurrent index build and then find nothing to do", async () => {
    const first = connect();
    const second = connect();
    const schema = newSchema();
    await first`CREATE SCHEMA ${first(schema)}`;
    await first`CREATE TABLE ${first(schema)}."t" ("a" int)`;
    await first`INSERT INTO ${first(schema)}."t" SELECT generate_series(1, 200000)`;
    const folder = folderWith(schema, [
      ["0000_index", `CREATE INDEX CONCURRENTLY IF NOT EXISTS "t_a" ON S."t" ("a");`],
    ]);
    const poll = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));

    await Promise.all([
      runMigrationsLocked(first, folder, { migrationsSchema: schema, sleep: poll }),
      runMigrationsLocked(second, folder, { migrationsSchema: schema, sleep: poll }),
    ]);

    expect(await recorded(first, schema)).toHaveLength(1);
  });
});
