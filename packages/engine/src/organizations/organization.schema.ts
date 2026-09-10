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
} from "drizzle-orm/pg-core";
import { users } from "../auth/users.schema.js";

/**
 * Multi-tenancy roots (RBAC Stream 0). The hierarchy is
 *   Organization -> Workspace -> Agent (live table still named `instances`).
 *
 * By default there is exactly one Organization (`is_default = true`) and one
 * Workspace inside it; the management API stays single-org. The schema is
 * already multi-org so supporting multiple organizations later needs no
 * additional migration.
 */

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  // true = implicit OSS organization seeded by the migration.
  isDefault: boolean("is_default").notNull().default(false),
  /**
   * How many knowledge documents ONE of this organization's agents may hold.
   *
   * NULL means the organization has none of its own and falls back to
   * `KNOWLEDGE_MAX_DOCS_PER_INSTANCE`, which stays as the deployment default.
   * The fallback is a DEFAULT and not a ceiling: an entitlement that could only
   * ever be lowered from a value baked into the environment would still need a
   * redeploy to sell. `knowledge/doc-cap.ts` is the only place it is resolved.
   */
  knowledgeMaxDocsPerAgent: integer("knowledge_max_docs_per_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_workspaces_org_slug").on(t.organizationId, t.slug),
    index("idx_workspaces_org").on(t.organizationId),
  ],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_org_memberships_org_user").on(t.organizationId, t.userId),
    index("idx_org_memberships_user").on(t.userId),
    index("idx_org_memberships_org").on(t.organizationId),
  ],
);
