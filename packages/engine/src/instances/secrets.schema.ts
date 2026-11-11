// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";

export const instanceSecrets = pgTable(
  "instance_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 100 }).notNull(),
    value: text("value").notNull(), // always encrypted
    /**
     * Keyed digest of the plaintext, only for a key that authenticates a request
     * (`auth_api_key`): the lookup by token reads this index instead of
     * decrypting every agent's key. NULL on every other key, and on a row
     * written before the column existed until a lookup fills it.
     */
    lookupDigest: varchar("lookup_digest", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique("uq_instance_secret_key").on(table.instanceId, table.key),
    index("idx_instance_secrets_lookup_digest").on(table.key, table.lookupDigest),
  ],
);
