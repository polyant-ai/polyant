// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Short-lived OAuth authorization state. The `state` param sent to the provider
 * is an unguessable nonce (not the conversationId), mapped here to the
 * conversation + provider + PKCE verifier. Single-use (deleted on consume) and
 * time-boxed (expires_at) → closes login-CSRF and, with PKCE, code interception.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    instanceId: text("instance_id").notNull(),
    provider: text("provider").notNull(),
    codeVerifier: text("code_verifier"), // AES-256-GCM (crypto/index.ts), never stored in clear
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_oauth_states_expires").on(table.expiresAt)],
);
