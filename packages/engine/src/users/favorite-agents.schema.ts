// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "../auth/users.schema.js";
import { instances } from "../instances/schema.js";

/**
 * The agents a person has starred, listed at the foot of the panel's sidebar.
 *
 * Bound to the USER, like `users.onboarding`: the star follows the person across
 * devices. It grants nothing; the panel shows a starred agent only when it is in
 * the agent list the reader may already load.
 */
export const userFavoriteAgents = pgTable(
  "user_favorite_agents",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.instanceId] }),
    // Backs the ON DELETE CASCADE from instances; the primary key serves the user side.
    index("idx_user_favorite_agents_instance_id").on(table.instanceId),
  ],
);
