// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, varchar, boolean, jsonb, integer, timestamp, index } from "drizzle-orm/pg-core";

export const toolAuditLogs = pgTable(
  "tool_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: text("agent_id").notNull(),
    conversationId: text("conversation_id"),
    toolName: varchar("tool_name", { length: 100 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    success: boolean("success").notNull().default(true),
    error: text("error"),
    durationMs: integer("duration_ms"),
    output: text("output"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_tool_audit_instance_created").on(table.instanceId, table.createdAt),
    index("idx_tool_audit_tool_created").on(table.toolName, table.createdAt),
    index("idx_tool_audit_conversation").on(table.conversationId),
  ],
);
