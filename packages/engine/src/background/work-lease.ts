// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { createLogger } from "../utils/create-logger.js";
import { errMsg } from "../utils/error.js";

const log = createLogger();

/**
 * How long a lease outlives its last renewal. The holder renews at a quarter of it,
 * so a live holder loses its lease only when it cannot reach the database for the
 * whole span; a dead one frees its work within it.
 */
export const WORK_LEASE_TTL_MS = 5 * 60_000;

/**
 * Renew a lease every quarter of `ttlMs` until the returned function is called, so a
 * live holder keeps it and a dead one loses it within `ttlMs`. The one renewal loop
 * for every lease the engine holds (`work_leases` here, a scheduled task's run lease
 * in its own row): `renew` resolves false when the lease was lost, which is logged
 * under `scope` with `onLost`; a renewal that throws is logged and the next one tried.
 */
export function keepLeaseAlive(
  ttlMs: number,
  renew: () => Promise<boolean>,
  logs: { scope: string; onLost: string; onError: (err: unknown) => string },
): () => void {
  const heartbeat = setInterval(() => {
    renew()
      .then((held) => {
        if (!held) log.warn(logs.scope, logs.onLost);
      })
      .catch((err) => log.warn(logs.scope, logs.onError(err)));
  }, ttlMs / 4);
  heartbeat.unref();
  return () => clearInterval(heartbeat);
}

/**
 * Take the lease on `key` when nobody holds a live one and, for a periodic job
 * (`everyMs`), when its last completed run is at least that old. Returns the token
 * that owns the lease, or null. Every time is read from the database clock, so
 * replicas whose clocks disagree still agree on who holds what.
 */
export async function acquireLease(key: string, opts: { everyMs?: number } = {}): Promise<string | null> {
  const owner = randomUUID();
  const rows = await db.execute<{ key: string }>(sql`
    INSERT INTO work_leases (key, owner, expires_at)
    VALUES (${key}, ${owner}, now() + ${WORK_LEASE_TTL_MS} * interval '1 millisecond')
    ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
    WHERE (work_leases.expires_at IS NULL OR work_leases.expires_at <= now())
      AND (${opts.everyMs ?? null}::bigint IS NULL OR work_leases.last_done_at IS NULL
        OR work_leases.last_done_at <= now() - ${opts.everyMs ?? null}::bigint * interval '1 millisecond')
    RETURNING key
  `);
  return rows.length > 0 ? owner : null;
}

/** Extend a lease `owner` holds. False when it was lost: it expired and was taken. */
export async function renewLease(key: string, owner: string): Promise<boolean> {
  const rows = await db.execute<{ key: string }>(sql`
    UPDATE work_leases SET expires_at = now() + ${WORK_LEASE_TTL_MS} * interval '1 millisecond'
    WHERE key = ${key} AND owner = ${owner}
    RETURNING key
  `);
  return rows.length > 0;
}

/** Free a lease `owner` holds; `done` records a completed run of a periodic job. */
export async function releaseLease(key: string, owner: string, opts: { done?: boolean } = {}): Promise<void> {
  await db.execute(sql`
    UPDATE work_leases
    SET owner = NULL, expires_at = NULL,
        last_done_at = CASE WHEN ${opts.done ?? false}::boolean THEN now() ELSE last_done_at END
    WHERE key = ${key} AND owner = ${owner}
  `);
}

/**
 * Run `body` while holding the lease on `key`, renewing it every quarter of its TTL.
 * Returns false, without running `body`, when the lease is held elsewhere (or, for a
 * periodic job, its interval has not elapsed). A periodic job is recorded as done when
 * `body` settles either way: a failed run waits for the next interval like a good one.
 */
export async function withLease(
  key: string,
  opts: { everyMs?: number },
  body: (owner: string) => Promise<void>,
): Promise<boolean> {
  const owner = await acquireLease(key, opts);
  if (!owner) return false;
  const stopRenewing = keepLeaseAlive(WORK_LEASE_TTL_MS, () => renewLease(key, owner), {
    scope: "work-lease",
    onLost: `lease ${key} expired while its work was still running`,
    onError: (err) => `lease ${key} renewal failed: ${errMsg(err)}`,
  });
  try {
    await body(owner);
  } finally {
    stopRenewing();
    await releaseLease(key, owner, { done: opts.everyMs !== undefined }).catch((err) =>
      log.warn("work-lease", `lease ${key} release failed, it frees itself on expiry: ${errMsg(err)}`),
    );
  }
  return true;
}
