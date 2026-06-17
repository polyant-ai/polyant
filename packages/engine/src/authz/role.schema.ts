// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  pgTable,
  uuid,
  varchar,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations/organization.schema.js";

/**
 * RBAC role catalog (Stream 0). The four system roles
 * (Owner/Admin/Member/Viewer) are seeded with `organization_id = NULL` and
 * `is_system = true`. A non-null `organization_id` is reserved for per-org
 * custom roles.
 */

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL = global system role; non-NULL = per-organization custom role.
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    key: varchar("key", { length: 50 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    level: integer("level").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_roles_org_key").on(t.organizationId, t.key),
    index("idx_roles_org").on(t.organizationId),
    index("idx_roles_system").on(t.isSystem),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: varchar("permission", { length: 100 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permission] }),
    index("idx_role_permissions_role").on(t.roleId),
  ],
);
