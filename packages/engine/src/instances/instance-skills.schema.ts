// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, boolean, timestamp, unique, index } from "drizzle-orm/pg-core";
import { agents } from "./schema.js";
import { skills, skillVersions } from "../skills/schema.js";

export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    autoLoad: boolean("auto_load").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_skill").on(table.agentId, table.skillId),
    index("idx_instance_skills_instance").on(table.agentId),
  ],
);
