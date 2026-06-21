// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { agents } from "../instances/schema.js";

/**
 * Per-contact opt-out state. One row per contact that has ever interacted with
 * the opt-out mechanism. Absence of a row = subscribed (default).
 *
 * Keyed by (agentId, channelType, channelId) so opt-out follows the contact
 * across every future conversation and Room cycle. The uuid FK to agents has
 * onDelete cascade, so rows drop on instance delete — but NOT on conversation
 * delete (a deleted conversation must never re-subscribe a contact).
 */
export const contactOptouts = pgTable(
  "contact_optouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    /** "opted_out" | "opted_in" */
    status: text("status").notNull(),
    /** Origin of the last transition: "user" (keyword) | "admin" (manual override). */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("contact_optouts_instance_channel_uq").on(t.agentId, t.channelType, t.channelId),
    index("contact_optouts_instance_status_idx").on(t.agentId, t.status),
  ],
);
