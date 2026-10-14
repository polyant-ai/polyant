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
 * `keyHash`, a SHA-256 digest (rows written before 1.2.0 hold a bcrypt hash and
 * are rewritten on first use). Only the hash is ever stored — the plaintext
 * secret is shown once at creation and is unrecoverable afterwards.
 *
 * An organization Owner issues and revokes keys from the panel
 * (`/api/organizations/:orgSlug/api-keys`). Every key this build issues carries
 * the full Owner permission set; choosing a narrower set is not offered here.
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
    // `sha256:<hex>` digest of the token secret (bcrypt on pre-1.2.0 rows).
    // Never the plaintext.
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
