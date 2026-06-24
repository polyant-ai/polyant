// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations/organization.schema.js";
import type { PermissionKey } from "../authz/permissions.js";

/**
 * Management API keys (RBAC Stream 5 — machine principals). A non-human caller
 * (CI, cron, a SaaS connector) authenticates to `/api/*` with the `X-Polyant-Key`
 * header instead of an OAuth session. Each key is org-scoped and carries an
 * explicit permission set, so a leaked key never grants more than it was issued.
 *
 * The presented token is `pk_<id>_<secret>`: the public `id` selects the row
 * (indexed lookup, no full-table scan) and `secret` is verified against
 * `keyHash` with bcrypt. Only the hash is ever stored — the plaintext secret is
 * shown once at creation and is unrecoverable afterwards.
 *
 * OSS ships a single Owner-permission key per org; the multi-key / scoped-key
 * surface is the same schema, gated by the entitlement layer.
 */
export const managementApiKeys = pgTable(
  "management_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Human-readable label shown in the admin UI (e.g. "CI pipeline").
    name: varchar("name", { length: 255 }).notNull(),
    // bcrypt hash of the token secret. Never the plaintext.
    keyHash: text("key_hash").notNull(),
    // The permission set this key may exercise. A subset of the org's role
    // matrix; the PermissionGuard allows a request only when its required
    // permission is a member of this set.
    permissions: jsonb("permissions")
      .$type<PermissionKey[]>()
      .notNull()
      .default([]),
    // Optional hard expiry. A request presenting a key past this instant is
    // rejected as if the key did not exist (401).
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Best-effort last-seen marker, refreshed on each successful validation.
    // Observability only — never gates the auth decision.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Backs the ON DELETE CASCADE from organizations and the per-org listing.
    index("idx_management_api_keys_org").on(t.organizationId),
  ],
);

export type ManagementApiKeyRow = typeof managementApiKeys.$inferSelect;
