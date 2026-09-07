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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_instance_mcp_server_slug").on(table.instanceId, table.slug),
    index("idx_instance_mcp_servers_instance").on(table.instanceId),
  ],
);
