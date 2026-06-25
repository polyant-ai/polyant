// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { agents } from "./schema.js";

export const agentChannels = pgTable(
  "agent_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    channelType: varchar("channel_type", { length: 50 }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    config: text("config").notNull(), // encrypted JSON
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_channel_type").on(table.agentId, table.channelType),
  ],
);
