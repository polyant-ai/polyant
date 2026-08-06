// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";

export const instancePrompts = pgTable(
  "agent_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("agent_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    sectionKey: varchar("section_key", { length: 50 }).notNull(),
    title: varchar("title", { length: 100 }).notNull(),
    content: text("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_prompt_section").on(table.instanceId, table.sectionKey),
    index("idx_instance_prompts_instance").on(table.instanceId),
  ],
);
