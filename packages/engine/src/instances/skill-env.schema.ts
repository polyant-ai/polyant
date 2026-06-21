// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";

// NOTE: FK skill_slug → skills.slug deferred to Fase 2 migration script.
// Must populate `skills` table before adding FK constraint, otherwise
// existing rows in instance_skill_env will violate the FK.
export const instanceSkillEnv = pgTable(
  "agent_skill_env",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("agent_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    skillSlug: varchar("skill_slug", { length: 100 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    value: text("value").notNull(),
    encrypted: boolean("encrypted").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_skill_key").on(table.instanceId, table.skillSlug, table.key),
  ],
);
