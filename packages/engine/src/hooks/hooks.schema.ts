// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, boolean, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { instances } from "../instances/schema.js";
import type { HookActionConfig } from "./hook-types.js";

/**
 * Per-instance lifecycle hooks: run an action (v1: a tool with template args)
 * when a conversation lifecycle event fires. See
 * docs/superpowers/specs/2026-06-10-hook-system-design.md.
 */
export const instanceHooks = pgTable(
  "instance_hooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 32 }).notNull(),
    actionType: varchar("action_type", { length: 32 }).notNull().default("tool"),
    actionConfig: jsonb("action_config").$type<HookActionConfig>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    position: integer("position").notNull().default(0),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_instance_hooks_instance_event").on(table.instanceId, table.event),
  ],
);
