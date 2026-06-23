// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Management-plane authorization audit log. The `audit_log:read` permission is
 * defined but inactive by default. The table is created up front so that
 * enabling read access later requires no additional migration.
 *
 * TODO(#110, RBAC Stream 7): nothing writes to this table yet — there is no
 * audit trail for RBAC mutations, so granting `audit_log:read` today only
 * exposes an always-empty table. The write path lands in the OSS
 * management-write-audit-log stream. Until then this is NOT an active control.
 */
export const authzAuditLogs = pgTable(
  "authz_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    actorUserId: uuid("actor_user_id"),
    // e.g. 'role_binding.create', 'role_binding.delete', 'member.remove'.
    action: varchar("action", { length: 100 }).notNull(),
    targetType: varchar("target_type", { length: 50 }),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: varchar("ip_address", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_authz_audit_org_created").on(t.organizationId, t.createdAt),
    index("idx_authz_audit_actor").on(t.actorUserId),
  ],
);
