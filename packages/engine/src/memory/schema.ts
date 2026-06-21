// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  vector,
  check,
} from "drizzle-orm/pg-core";

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: text("agent_id").notNull(),
    content: text("content").notNull(),
    category: text("category").notNull().default("general"),
    importance: integer("importance").notNull().default(5),
    sourceConversationId: text("source_conversation_id"),
    embedding: vector("embedding", { dimensions: 1536 }),
    embedding1024: vector("embedding_1024", { dimensions: 1024 }),
    embeddingProvider: text("embedding_provider"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_memories_instance_id").on(table.instanceId),
    index("idx_memories_category").on(table.category),
    index("idx_memories_created_at").on(table.createdAt),
    check(
      "memories_embedding_xor",
      sql`(${table.embedding} IS NULL) <> (${table.embedding1024} IS NULL)`,
    ),
  ],
);
