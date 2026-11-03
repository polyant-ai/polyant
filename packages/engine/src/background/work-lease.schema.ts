// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One row per unit of background work that must run in one process at a time. */
export const workLeases = pgTable("work_leases", {
  key: text("key").primaryKey(),
  /** The token of the lease's holder; null when free. */
  owner: text("owner"),
  /** Set from the database clock; a lease past it is free. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** When a periodic job last completed. */
  lastDoneAt: timestamp("last_done_at", { withTimezone: true }),
});
