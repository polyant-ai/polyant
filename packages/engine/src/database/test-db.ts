// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db, queryClient } from "./client.js";

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
  // The timer is cleared in `finally`: left running, every integration file
  // that imports `resolveDatabaseAvailability` held the event loop open for
  // PROBE_TIMEOUT_MS after the probe had already answered.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("db probe timeout")), PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
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

/**
 * Hold a Postgres advisory lock for the length of a suite, on one reserved
 * connection so the release reaches the session that took it. `shared` holders
 * run alongside each other; an `exclusive` holder runs alone. For suites that
 * act on the WHOLE shared test database (a prune, a backfill) and the suites
 * whose rows that would touch.
 *
 * Call before the suite seeds anything, and the returned release once it has
 * cleaned up. No database: the suites skip themselves, and nothing is held.
 */
export async function lockTestResource(key: string, mode: "shared" | "exclusive"): Promise<() => Promise<void>> {
  if (!(await probeDatabase())) return async () => {};
  const connection = await queryClient.reserve();
  if (mode === "exclusive") await connection`SELECT pg_advisory_lock(hashtext(${key}))`;
  else await connection`SELECT pg_advisory_lock_shared(hashtext(${key}))`;
  return async () => {
    if (mode === "exclusive") await connection`SELECT pg_advisory_unlock(hashtext(${key}))`;
    else await connection`SELECT pg_advisory_unlock_shared(hashtext(${key}))`;
    connection.release();
  };
}

/**
 * The shared `tools` table: `syncToolsToDb()` prunes every namespaced tool
 * whose plugin is not loaded — on a test database that is every row another
 * suite inserted for its own plugin (`hubspot:note`, `<marker>-crm:search`, …).
 * A suite that prunes holds it `exclusive`; a suite whose rows a prune would
 * delete holds it `shared`.
 */
export function lockToolsTable(mode: "shared" | "exclusive"): Promise<() => Promise<void>> {
  return lockTestResource("itest:tools-table-namespaced", mode);
}
