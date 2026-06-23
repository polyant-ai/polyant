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

export { queryClient };
