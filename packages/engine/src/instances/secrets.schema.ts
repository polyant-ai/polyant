// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, timestamp, unique } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";

export const instanceSecrets = pgTable(
  "agent_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("agent_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    value: text("value").notNull(), // always encrypted
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_secret_key").on(table.instanceId, table.key),
  ],
);
