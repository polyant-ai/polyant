// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Each pool's statement cap reaches Postgres: the analytics pool's short one
 * for dashboard aggregates, and the main pool's generous one, so a conversation
 * turn is never cut by a limit meant for dashboards while a stuck statement or a
 * transaction left open still gives its connection back. Self-skips without a
 * migrated database.
 */

import { resolveDatabaseAvailability } from "./test-db.js";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { analyticsDb, db } from "./client.js";
import { config } from "../config.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

/** The session's value of a timeout, in milliseconds (the unit `pg_settings` reports them in). */
async function setting(executor: typeof db, name: "statement_timeout" | "idle_in_transaction_session_timeout"): Promise<number> {
  const rows = (await executor.execute(
    sql`SELECT setting FROM pg_settings WHERE name = ${name}`,
  )) as unknown as Array<{ setting: string }>;
  return Number(rows[0].setting);
}

describe("connection pools (integration)", () => {
  it.skipIf(!DB_AVAILABLE)("caps statements on the analytics pool with its own limit", async () => {
    expect(await setting(analyticsDb, "statement_timeout")).toBe(config.postgres.analyticsStatementTimeoutMs);
  });

  it.skipIf(!DB_AVAILABLE)("caps statements and idle transactions on the main pool, more generously", async () => {
    expect(config.postgres.statementTimeoutMs).toBeGreaterThan(config.postgres.analyticsStatementTimeoutMs);
    expect(await setting(db, "statement_timeout")).toBe(config.postgres.statementTimeoutMs);
    expect(await setting(db, "idle_in_transaction_session_timeout")).toBe(
      config.postgres.idleInTransactionTimeoutMs,
    );
  });
});
