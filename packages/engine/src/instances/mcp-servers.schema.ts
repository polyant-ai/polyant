import { pgTable, uuid, varchar, text, boolean, timestamp, unique, index } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";

export const instanceMcpServers = pgTable(
  "instance_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 50 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    url: text("url").notNull(),
    authMode: varchar("auth_mode", { length: 20 }).notNull().default("static"),
    enabled: boolean("enabled").notNull().default(true),
    config: text("config").notNull(), // encrypted JSON
    // The account an admin connected for the whole agent (`account: "shared"`
    // in an oauth config): encrypted OAuth tokens, when and by whom. Kept out
    // of `config` because the panel reads that back and the export copies it.
    // `sharedConnectedBy` carries no foreign key: the connection outlives the
    // admin's user row.
    sharedTokens: text("shared_tokens"),
    sharedConnectedAt: timestamp("shared_connected_at", { withTimezone: true }),
    sharedConnectedBy: uuid("shared_connected_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_instance_mcp_server_slug").on(table.instanceId, table.slug),
    index("idx_instance_mcp_servers_instance").on(table.instanceId),
  ],
);
