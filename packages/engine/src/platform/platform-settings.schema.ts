// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, boolean, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../auth/users.schema.js";

/**
 * The installation's own policies — the tier that had no table.
 *
 * ONE row, and the primary key is what enforces it: `id` is a boolean that may
 * only be true, so a second row is a constraint violation rather than a silent
 * second opinion about the same policy. The row is seeded by the migration with
 * both values unset, so a reader never has to tell "no row yet" from "row with
 * NULLs" — two shapes for one question.
 *
 * NULL means "not set here" and falls back to the environment variable that used
 * to be the only answer. `updatedBy` is nullable because a user may be deleted
 * after setting a policy; the management audit trail is what survives.
 */
export const platformSettings = pgTable("platform_settings", {
  id: boolean("id").primaryKey().default(true),
  /**
   * How many days of `ai_logs` and `pipeline_traces` the daily housekeeping
   * keeps. Policy, not capacity — and the one value here whose wrong setting
   * destroys data, which is why the route that writes it is audited.
   */
  analyticsRetentionDays: integer("analytics_retention_days"),
  /** Concurrent activity-stream subscribers ONE authenticated user may hold. */
  sseMaxConnectionsPerUser: integer("sse_max_connections_per_user"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});
