// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, boolean, timestamp, integer, date, unique, index } from "drizzle-orm/pg-core";
import { instances } from "../instances/schema.js";

export const instanceRoom = pgTable(
  "agent_room",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("agent_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    prompt: text("prompt").notNull().default(""),
    outboundChannel: varchar("outbound_channel", { length: 50 }),
    outboundTarget: text("outbound_target"),
    evalIntervalMinutes: integer("eval_interval_minutes").notNull().default(5),
    conversationId: text("conversation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_instance_room").on(table.instanceId),
  ],
);

export const roomActivityLog = pgTable(
  "room_activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("agent_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    logDate: date("log_date").notNull(),
    logType: varchar("log_type", { length: 10 }).notNull(),
    content: text("content").notNull(),
    eventCount: integer("event_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_room_activity_instance_date_type").on(table.instanceId, table.logDate, table.logType),
    index("idx_room_activity_instance_date").on(table.instanceId, table.logDate),
  ],
);
