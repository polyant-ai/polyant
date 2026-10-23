// SPDX-License-Identifier: AGPL-3.0-or-later

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { openPostgres } from "./open-postgres.js";

const DB_SECRET = "synthetic-db-secret-7f3a";

/** What the boot would print for the error: Node shows an uncaught error through inspect(). */
function printedFailure(url: string): string {
  try {
    openPostgres(url, {});
  } catch (err) {
    return inspect(err, { depth: 10 });
  }
  throw new Error(`expected ${url} to be refused`);
}

describe("openPostgres", () => {
  it("names the variables and never prints the password when the driver cannot read the string", () => {
    const unreadable = [
      // POSTGRES_PORT that is not a number, as a Kubernetes Service named `postgres` sets it.
      `postgresql://polyant:${DB_SECRET}@postgres:tcp://10.96.0.12:5432/polyant`,
      `postgresql://polyant:${DB_SECRET}@db:abc/polyant`,
      // An unencoded `#` in a DATABASE_URL password.
      `postgresql://polyant:${DB_SECRET}#x@db:5432/polyant`,
    ];
    for (const url of unreadable) {
      const printed = printedFailure(url);
      expect(printed, url).toContain("POSTGRES_PORT (a number)");
      expect(printed, url).not.toContain(DB_SECRET);
    }
  });

  it("opens a readable connection string, failover host list included", async () => {
    for (const url of [`postgresql://polyant:${DB_SECRET}@db:5432/polyant`, "postgresql://u:p@h1:5432,h2:5433/d"]) {
      const sql = openPostgres(url, { max: 1 });
      expect(typeof sql.begin, url).toBe("function");
      await sql.end();
    }
  });
});
