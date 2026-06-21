// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, timestamp, unique } from "drizzle-orm/pg-core";
import { agents } from "./schema.js";

export const agentSecrets = pgTable(
  "agent_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    value: text("value").notNull(), // always encrypted
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_secret_key").on(table.agentId, table.key),
  ],
);
