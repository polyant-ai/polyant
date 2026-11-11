// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type SQL } from "drizzle-orm";
import { db } from "./client.js";

/**
 * Whether this database's pgvector can keep walking its HNSW index until a
 * filtered query has its rows (`hnsw.iterative_scan`, pgvector 0.8.0). Read once
 * per process from the installed extension version: a server library newer
 * than the installed version only costs the exact fallback below.
 */
let hnswIterativeScan: Promise<boolean> | undefined;

function hnswIterativeScanAvailable(): Promise<boolean> {
  hnswIterativeScan ??= db
    .execute(sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)
    .then((rows) => {
      const version = (rows as unknown as Array<{ extversion?: string }>)[0]?.extversion ?? "";
      const [major = 0, minor = 0] = version.split(".").map(Number);
      return major > 0 || minor >= 8;
    })
    .catch((err: unknown) => {
      hnswIterativeScan = undefined;
      throw err;
    });
  return hnswIterativeScan;
}

/** Pin the capability read from the database; `undefined` reads it again. */
export function _setHnswIterativeScanForTests(available: boolean | undefined): void {
  hnswIterativeScan = available === undefined ? undefined : Promise.resolve(available);
}

/**
 * The `SET LOCAL` that keeps a per-agent nearest-neighbour query complete, to run
 * first inside the query's transaction (outside one it is a silent no-op).
 *
 * The vector columns have one HNSW index for the whole table, and the planner
 * picks it once an agent holds enough rows. The index returns its
 * `hnsw.ef_search` (40) nearest rows of every agent and the agent filter runs
 * after it, so an agent owning a fraction of those rows got that fraction of
 * `limit`. With `iterative_scan = strict_order` the index keeps scanning, in
 * distance order, until `limit` rows pass the filter (or `hnsw.max_scan_tuples`,
 * 20,000 by default, have been visited); on a pgvector without it the index is
 * off for the transaction and the agent's rows are scanned exactly.
 *
 * Resolve it before opening the transaction: the first call reads the extension
 * version on the shared pool, which a caller holding the pool's last connection
 * would wait on forever.
 */
export async function completeVectorScanSetting(): Promise<SQL> {
  return (await hnswIterativeScanAvailable())
    ? sql`SET LOCAL hnsw.iterative_scan = strict_order`
    : sql`SET LOCAL enable_indexscan = off`;
}
