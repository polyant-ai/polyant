// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import type { Sql } from "postgres";
import {
  describeMigrationError,
  waitForDatabase,
  isConnectionNotReadyError,
  CONNECT_RETRY_DELAYS_MS,
} from "./run-migrations.js";

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
    const sleep = vi.fn(async () => {});
    await waitForDatabase(sql, { sleep });
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on connection refused with the backoff delays, then succeeds", async () => {
    const { sql, calls } = fakeSql([pgError("ECONNREFUSED", "r"), pgError("EAI_AGAIN", "d"), null]);
    const sleep = vi.fn(async () => {});
    await waitForDatabase(sql, { sleep });
    expect(calls()).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(CONNECT_RETRY_DELAYS_MS.slice(0, 2));
  });

  it("gives up after about 60 s of waiting and rethrows the last error", async () => {
    const errs = Array.from({ length: CONNECT_RETRY_DELAYS_MS.length + 1 }, () => pgError("ECONNREFUSED", "r"));
    const { sql, calls } = fakeSql(errs);
    const sleep = vi.fn(async () => {});
    await expect(waitForDatabase(sql, { sleep })).rejects.toThrow("r");
    expect(calls()).toBe(CONNECT_RETRY_DELAYS_MS.length + 1);
    const total = sleep.mock.calls.reduce((a, c) => a + (c[0] as number), 0);
    expect(total).toBeGreaterThanOrEqual(55_000);
    expect(total).toBeLessThanOrEqual(65_000);
  });

  it("does not retry errors that waiting cannot fix", async () => {
    const { sql, calls } = fakeSql([pgError("28P01", "password authentication failed")]);
    const sleep = vi.fn(async () => {});
    await expect(waitForDatabase(sql, { sleep })).rejects.toThrow("password");
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
