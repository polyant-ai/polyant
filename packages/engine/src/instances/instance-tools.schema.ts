// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, timestamp, unique, index } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";
import { tools } from "../agents/tools/tools.schema.js";

export const instanceTools = pgTable(
  "agent_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("agent_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => tools.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 20 }).notNull().default("manual"),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_tool").on(table.instanceId, table.toolId),
    index("idx_instance_tools_instance").on(table.instanceId),
  ],
);
