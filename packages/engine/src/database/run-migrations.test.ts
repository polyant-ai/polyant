// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Sql } from "postgres";
import {
  describeMigrationError,
  waitForDatabase,
  isConnectionNotReadyError,
  readMigrations,
  CONNECT_RETRY_DELAYS_MS,
} from "./run-migrations.js";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

/** A migrations folder holding the given files, in journal order. */
function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  mkdirSync(join(dir, "meta"));
  const entries = Object.keys(files).map((tag, idx) => ({ idx, version: "7", when: 1_000 + idx, tag, breakpoints: true }));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  for (const [tag, sql] of Object.entries(files)) writeFileSync(join(dir, `${tag}.sql`), sql);
  return dir;
}

describe("readMigrations", () => {
  it("records every migration with the hash, timestamp and statements drizzle's migrator uses", () => {
    const ours = readMigrations(migrationsFolder);
    const drizzles = readMigrationFiles({ migrationsFolder });
    expect(ours.length).toBeGreaterThan(100);
    expect(ours.map((m) => ({ hash: m.hash, when: m.when, sql: m.statements }))).toEqual(
      drizzles.map((m) => ({ hash: m.hash, when: m.folderMillis, sql: m.sql })),
    );
  });

  it("runs a file of concurrent index statements outside a transaction, and any other file inside one", () => {
    const folder = folderWith({
      a_table: 'CREATE TABLE "t" ("a" int);\nCREATE INDEX IF NOT EXISTS "t_a" ON "t" ("a");',
      b_concurrent:
        '-- comment\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "t_b" ON "t" ("a");\n--> statement-breakpoint\n' +
        'DROP INDEX CONCURRENTLY IF EXISTS "t_a";\n',
      c_comment_only: "-- nothing to do\n",
    });
    expect(readMigrations(folder).map((m) => [m.tag, m.concurrent])).toEqual([
      ["a_table", false],
      ["b_concurrent", true],
      ["c_comment_only", false],
    ]);
  });

  it.each([
    ["with other SQL", 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" ("a");\n--> statement-breakpoint\nALTER TABLE "t" ADD COLUMN "b" int;'],
    ["two in one part", 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" ("a"); DROP INDEX CONCURRENTLY IF EXISTS "j";'],
    ["without IF NOT EXISTS", 'CREATE INDEX CONCURRENTLY "i" ON "t" ("a");'],
  ])("rejects a concurrent index statement %s before anything runs", (_, sql) => {
    expect(() => readMigrations(folderWith({ bad: sql }))).toThrow(/Migration bad mixes concurrent index statements/);
  });
});

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("describeMigrationError", () => {
  it("tells the operator to create the vector extension as a superuser", () => {
    const err = pgError("42501", 'permission denied to create extension "vector"');
    const out = describeMigrationError(err);
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toContain("CREATE EXTENSION vector");
    expect(out.message).toContain("superuser");
    expect((out as Error & { cause?: unknown }).cause).toBe(err);
  });

  it("recognises the error when drizzle wraps it as a cause", () => {
    const inner = pgError("42501", 'permission denied to create extension "vector"');
    const outer = new Error("Failed query: CREATE EXTENSION IF NOT EXISTS vector", { cause: inner });
    expect(describeMigrationError(outer).message).toContain("CREATE EXTENSION vector");
  });

  it("returns other errors unchanged", () => {
    const err = pgError("42501", 'permission denied for table "users"');
    expect(describeMigrationError(err)).toBe(err);
    const plain = new Error("boom");
    expect(describeMigrationError(plain)).toBe(plain);
  });
});

describe("isConnectionNotReadyError", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "CONNECT_TIMEOUT"])("%s is retryable", (code) => {
    expect(isConnectionNotReadyError(pgError(code, "x"))).toBe(true);
  });

  it("is not retryable for auth or SQL errors", () => {
    expect(isConnectionNotReadyError(pgError("28P01", "password authentication failed"))).toBe(false);
    expect(isConnectionNotReadyError(new Error("boom"))).toBe(false);
  });
});

describe("waitForDatabase", () => {
  function fakeSql(results: Array<Error | null>): { sql: Sql; calls: () => number } {
    let n = 0;
    const sql = (() => {
      const r = results[n++];
      return r ? Promise.reject(r) : Promise.resolve([{ "?column?": 1 }]);
    }) as unknown as Sql;
    return { sql, calls: () => n };
  }

  it("returns at once when the database answers", async () => {
    const { sql, calls } = fakeSql([null]);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await waitForDatabase(sql, { sleep });
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on connection refused with the backoff delays, then succeeds", async () => {
    const { sql, calls } = fakeSql([pgError("ECONNREFUSED", "r"), pgError("EAI_AGAIN", "d"), null]);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await waitForDatabase(sql, { sleep });
    expect(calls()).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(CONNECT_RETRY_DELAYS_MS.slice(0, 2));
  });

  it("gives up after about 60 s of waiting and rethrows the last error", async () => {
    const errs = Array.from({ length: CONNECT_RETRY_DELAYS_MS.length + 1 }, () => pgError("ECONNREFUSED", "r"));
    const { sql, calls } = fakeSql(errs);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await expect(waitForDatabase(sql, { sleep })).rejects.toThrow("r");
    expect(calls()).toBe(CONNECT_RETRY_DELAYS_MS.length + 1);
    const total = sleep.mock.calls.reduce((a, c) => a + c[0], 0);
    expect(total).toBeGreaterThanOrEqual(55_000);
    expect(total).toBeLessThanOrEqual(65_000);
  });

  it("does not retry errors that waiting cannot fix", async () => {
    const { sql, calls } = fakeSql([pgError("28P01", "password authentication failed")]);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    await expect(waitForDatabase(sql, { sleep })).rejects.toThrow("password");
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
