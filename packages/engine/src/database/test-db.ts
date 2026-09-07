// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "./client.js";

/**
 * Is a database reachable for the integration tier?
 *
 * This probe was copy-pasted verbatim into five integration files, each with its
 * own three-second race, so there was no single place to change the policy — and
 * no single place to enforce it. That mattered: the files self-skip when the
 * probe loses, so a database that is merely SLOW to accept turns the whole tier
 * into "9 passed" with exit code 0, silently dropping all seven cross-org
 * isolation tests and all eleven migration-seed tests. Nothing asserted a floor.
 *
 * `CI_REQUIRE_DB` is that floor. Unset (a developer's machine), an absent
 * database still skips, which is the behaviour that keeps the unit tier fast and
 * the integration tier optional. Set (CI, where a `postgres` service is
 * declared), an unreachable database is a FAILURE — because there the skip is
 * never the honest answer.
 */
const PROBE_TIMEOUT_MS = 3000;

export async function probeDatabase(): Promise<boolean> {
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db probe timeout")), PROBE_TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** True when the caller must treat an unreachable database as a failure. */
export function databaseIsRequired(): boolean {
  return process.env.CI_REQUIRE_DB === "1";
}

/**
 * Resolve database availability for an integration file, failing loudly when the
 * environment promised one. Await once at module scope and pass the result to
 * `describe.skipIf(!DB_AVAILABLE)`.
 */
export async function resolveDatabaseAvailability(): Promise<boolean> {
  const available = await probeDatabase();
  if (!available && databaseIsRequired()) {
    throw new Error(
      "CI_REQUIRE_DB=1 but the database did not answer `select 1` within " +
        `${PROBE_TIMEOUT_MS}ms. The integration tier self-skips when the probe fails, ` +
        "so continuing here would report a green run that exercised none of it.",
    );
  }
  return available;
}
