// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, unique, index } from "drizzle-orm/pg-core";
import { agents } from "../instances/schema.js";

export const eventSources = pgTable(
  "event_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    sourceType: varchar("source_type", { length: 50 }).notNull(),
    config: text("config").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    webhookToken: varchar("webhook_token", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_event_source_webhook_token").on(table.webhookToken),
    index("idx_event_sources_instance").on(table.agentId),
  ],
);

export const eventDefinitions = pgTable(
  "event_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventSourceId: uuid("event_source_id").notNull().references(() => eventSources.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    matchingPrompt: text("matching_prompt").notNull(),
    interpretationPrompt: text("interpretation_prompt").notNull(),
    action: varchar("action", { length: 20 }).notNull().default("backlog"),
    contextPrompt: text("context_prompt"),
    outboundChannel: varchar("outbound_channel", { length: 50 }),
    outboundTarget: text("outbound_target"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_event_definitions_source").on(table.eventSourceId),
  ],
);

export const eventBacklog = pgTable(
  "event_backlog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    eventDefinitionId: uuid("event_definition_id").notNull().references(() => eventDefinitions.id, { onDelete: "cascade" }),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reactNotes: text("react_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_event_backlog_instance_status").on(table.agentId, table.status),
    index("idx_event_backlog_definition").on(table.eventDefinitionId),
  ],
);
