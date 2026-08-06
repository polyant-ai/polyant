// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, text, timestamp, index, primaryKey } from "drizzle-orm/pg-core";

/**
 * Encrypted per-principal secret store — the cifered sibling of
 * `conversation_state`. Holds sensitive per-conversation values (today: OAuth
 * access/refresh tokens) that must NOT live in the cleartext, promptable state
 * blob. Values are AES-256-GCM (see crypto/) — never stored or logged in clear.
 *
 * `scope` / `scope_key` mirror `conversation_state`'s abstraction: today only
 * `scope = "conversation"` (`scope_key` = conversationId); a future "principal"
 * tier (same token shared across a person's conversations) drops in without a
 * schema change. `expires_at` is nullable — populated for tokens that expire
 * (Google access token) to drive refresh; null = never expires (GitHub).
 */
export const principalSecrets = pgTable(
  "principal_secrets",
  {
    scope: text("scope").notNull().default("conversation"),
    scopeKey: text("scope_key").notNull(),
    instanceId: text("agent_id"),
    key: text("key").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.scopeKey, table.key] }),
    index("idx_principal_secrets_scope_key").on(table.scopeKey),
    index("idx_principal_secrets_instance").on(table.instanceId),
  ],
);
