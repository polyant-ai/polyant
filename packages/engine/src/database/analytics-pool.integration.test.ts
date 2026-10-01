// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The analytics pool's statement cap reaches Postgres, and the main pool is
 * left without one: a conversation turn's statements must never be cut by a
 * limit meant for dashboard aggregates. Self-skips without a migrated database.
 */

import { resolveDatabaseAvailability } from "./test-db.js";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { analyticsDb, db } from "./client.js";
import { config } from "../config.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

async function statementTimeout(executor: typeof db): Promise<string> {
  const rows = (await executor.execute(sql`SHOW statement_timeout`)) as unknown as Array<{ statement_timeout: string }>;
  return rows[0].statement_timeout;
}

describe("analytics connection pool (integration)", () => {
  it.skipIf(!DB_AVAILABLE)("caps statements on the analytics pool only", async () => {
    expect(await statementTimeout(analyticsDb)).toBe(`${config.postgres.analyticsStatementTimeoutMs / 1000}s`);
    expect(await statementTimeout(db)).toBe("0");
  });
});
