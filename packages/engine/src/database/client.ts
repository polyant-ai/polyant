// SPDX-License-Identifier: AGPL-3.0-or-later

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";

const queryClient = postgres(config.postgres.databaseUrl, {
  connection: { TimeZone: "UTC" },
  ssl: config.postgres.ssl ? { rejectUnauthorized: false } : false,
});

export const db = drizzle(queryClient);

/** The transaction handle passed to a `db.transaction(async (tx) => …)` callback. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either the root db or an open transaction — for helpers that compose into a larger tx. */
export type DbExecutor = typeof db | DbTransaction;

/**
 * "This call is NOT inside a transaction" — said out loud.
 *
 * It is `db`, named for what a call site means by passing it. The helpers that
 * can compose into a larger transaction take their executor as a REQUIRED
 * argument, because the default was the unsafe half: a module-level `db` read
 * cannot see a row inserted in the same transaction under READ COMMITTED, and
 * a caller who forgot the handle got that silently. Required means the author
 * has to answer the question; this is the answer for a request path, and it
 * spells the answer instead of reaching for the database client from a place
 * that has no business holding one — a controller, say.
 */
export const NO_TRANSACTION = db;

export { queryClient };
