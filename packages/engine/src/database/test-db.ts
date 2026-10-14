// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db, queryClient } from "./client.js";

/**
 * Is a database reachable for the integration tier?
 *
 * Two different answers hide behind "no". A database that is ABSENT refuses the
 * connection at once (nothing listens, the host does not resolve, the role or
 * database does not exist): the integration files skip, which keeps a bare
 * `npm test` green on a machine without Postgres. A database that is PRESENT but
 * slow — busy with the other workers of a parallel run — answers late. The old
 * probe raced both against three seconds and called the late answer "absent",
 * so a loaded machine turned files into silent skips with exit code 0.
 *
 * Now only a refusal means absent. A probe that gets no answer at all within
 * PROBE_TIMEOUT_MS throws: a database that is there and does not answer is a
 * broken run, never a skip. `CI_REQUIRE_DB=1` additionally turns "absent" into a
 * failure, because in CI a skip is never the honest answer.
 *
 * The answer is memoized per worker: the availability check and every
 * `lockTestResource` in a file share one probe.
 */
const PROBE_TIMEOUT_MS = 20_000;

class ProbeTimeout extends Error {}

let probe: Promise<boolean> | undefined;

async function runProbe(): Promise<boolean> {
  // The timer is cleared in `finally`: left running, it would hold the worker's
  // event loop open after the probe had already answered.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout()), PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (err) {
    if (err instanceof ProbeTimeout) {
      throw new Error(
        `The database did not answer \`select 1\` within ${PROBE_TIMEOUT_MS}ms. It is configured and ` +
          "accepting connections slowly or not at all; skipping here would report a green run " +
          "that exercised none of the integration tier.",
        { cause: err },
      );
    }
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function probeDatabase(): Promise<boolean> {
  probe ??= runProbe();
  return probe;
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
      "CI_REQUIRE_DB=1 but the database refused the connection. The integration tier " +
        "self-skips when no database is there, so continuing here would report a green " +
        "run that exercised none of it.",
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
