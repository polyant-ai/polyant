// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";

export const instances = pgTable("instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  provider: varchar("provider", { length: 50 }),
  model: varchar("model", { length: 100 }),
  memoryEnabled: boolean("memory_enabled").notNull().default(true),
  knowledgeEnabled: boolean("knowledge_enabled").notNull().default(false),
  langsmithEnabled: boolean("langsmith_enabled").notNull().default(false),
  langsmithProject: varchar("langsmith_project", { length: 255 }),
  authEnabled: boolean("auth_enabled").notNull().default(false),
  thinkingEnabled: boolean("thinking_enabled").notNull().default(false),
  icon: text("icon"),
  sttProvider: text("stt_provider").notNull().default("openai"),
  embeddingDim: integer("embedding_dim").notNull().default(1536),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
