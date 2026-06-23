// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "../auth/users.schema.js";
import { roles } from "./role.schema.js";
import { organizations } from "../organizations/organization.schema.js";

export type ScopeType = "organization" | "workspace";

/**
 * A binding grants a user a role over a scope (organization or workspace).
 *
 * `scopeId` is polymorphic (it points at either an organization or a workspace)
 * so it carries no declarative FK. Integrity is enforced by the
 * `check_role_binding_scope` trigger created in the migration: for an
 * organization scope `scope_id` must equal `organization_id`; for a workspace
 * scope the workspace must belong to the binding organization.
 */
export const roleBindings = pgTable(
  "role_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 20 }).notNull().$type<ScopeType>(),
    scopeId: uuid("scope_id").notNull(),
    // Denormalized for tenant isolation and single-index binding lookups.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => [
    // One binding per (user, role, scope) — makes idempotency a DB invariant
    // instead of a select-then-insert guard, closing the TOCTOU race under
    // concurrent sign-in / rolling restart. Callers use onConflictDoNothing.
    uniqueIndex("uq_role_bindings_user_role_scope").on(
      t.userId,
      t.roleId,
      t.scopeType,
      t.scopeId,
      t.organizationId,
    ),
    index("idx_role_bindings_user_org").on(t.userId, t.organizationId),
    index("idx_role_bindings_scope").on(t.scopeType, t.scopeId),
  ],
);
