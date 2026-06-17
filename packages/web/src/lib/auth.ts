// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Full Auth.js config with Drizzle DB adapter.
 * Only used in server-side Node.js contexts (API routes, server components).
 * Middleware uses auth.config.ts instead (Edge-compatible).
 */
import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  primaryKey,
} from "drizzle-orm/pg-core";
import { authConfig } from "./auth.config";
import {
  provisionUserDefaultOrg,
  resolveSignInOrgId,
  type OrgProvisioningPort,
} from "./org-provisioning";

const connectionString = process.env.DATABASE_URL ??
  `postgres://${process.env.POSTGRES_USER ?? "polyant"}:${process.env.POSTGRES_PASSWORD ?? ""}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5432"}/${process.env.POSTGRES_DB ?? "polyant"}`;

const queryClient = postgres(connectionString);
const db = drizzle(queryClient);

/**
 * Auth.js-compatible schema matching engine's users.schema.ts
 * (snake_case DB columns, custom table names)
 */
const usersTable = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  image: text("image"),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
});

const accountsTable = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 50 }).notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: varchar("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
});

const sessionsTable = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionToken: text("session_token").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

const verificationTokensTable = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull().unique(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

/**
 * RBAC tenancy tables (subset) matching engine's organization.schema.ts /
 * authz schemas. Defined here so the Node-side Auth.js callbacks can resolve a
 * user's organization at sign-in without reaching into the engine package.
 */
const organizationsTable = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
});

const organizationMembershipsTable = pgTable("organization_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
});

const rolesTable = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id"),
  key: varchar("key", { length: 50 }).notNull(),
  isSystem: boolean("is_system").notNull().default(false),
});

const roleBindingsTable = pgTable("role_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  roleId: uuid("role_id").notNull(),
  scopeType: varchar("scope_type", { length: 20 }).notNull(),
  scopeId: uuid("scope_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
});

/**
 * Concrete {@link OrgProvisioningPort} backed by the postgres-js Drizzle client.
 * The pure orchestration lives in `org-provisioning.ts` (unit tested); this is
 * the thin SQL adapter, mirroring the engine store's idempotent upserts.
 */
const orgProvisioningPort: OrgProvisioningPort = {
  async findDefaultOrgId() {
    const [row] = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.isDefault, true))
      .limit(1);
    return row?.id ?? null;
  },
  async findUserOrgId(userId) {
    const [row] = await db
      .select({ id: organizationMembershipsTable.organizationId })
      .from(organizationMembershipsTable)
      .where(eq(organizationMembershipsTable.userId, userId))
      .limit(1);
    return row?.id ?? null;
  },
  async findOwnerRoleId() {
    const [row] = await db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(and(eq(rolesTable.key, "owner"), eq(rolesTable.isSystem, true)))
      .limit(1);
    return row?.id ?? null;
  },
  async ensureMembership(organizationId, userId) {
    await db
      .insert(organizationMembershipsTable)
      .values({ organizationId, userId })
      .onConflictDoNothing({
        target: [
          organizationMembershipsTable.organizationId,
          organizationMembershipsTable.userId,
        ],
      });
  },
  async ensureOwnerBinding(organizationId, userId, ownerRoleId) {
    const existing = await db
      .select({ id: roleBindingsTable.id })
      .from(roleBindingsTable)
      .where(
        and(
          eq(roleBindingsTable.userId, userId),
          eq(roleBindingsTable.organizationId, organizationId),
          eq(roleBindingsTable.scopeType, "organization"),
          eq(roleBindingsTable.roleId, ownerRoleId),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    await db.insert(roleBindingsTable).values({
      userId,
      roleId: ownerRoleId,
      scopeType: "organization",
      scopeId: organizationId,
      organizationId,
    });
  },
};

/**
 * The Edge-safe `jwt` callback (from `auth.config.ts`) handles role /
 * mustChangePassword. Here in the Node context we additionally resolve and
 * stamp `orgId` at sign-in, which requires DB access the Edge runtime can't do.
 * `orgId` is resolved only on the first call (when `user` is present) and then
 * persisted on the token for subsequent requests. It is NEVER accepted from a
 * client `update` patch — same hardening rationale as `role`.
 */
const baseJwtCallback = authConfig.callbacks?.jwt;

async function jwtWithOrg(params: Parameters<NonNullable<typeof baseJwtCallback>>[0]) {
  const token = (baseJwtCallback ? await baseJwtCallback(params) : params.token) as JWT;
  if (!token) return token;

  const { user } = params;
  // Only resolve at sign-in. The id is stamped by the base callback (token.id)
  // or available on the freshly authenticated user object.
  if (user) {
    const userId =
      ((user as { id?: string }).id ?? (token.id as string | undefined)) ?? undefined;
    if (userId) {
      try {
        const orgId = await resolveSignInOrgId(orgProvisioningPort, userId);
        if (orgId) token.orgId = orgId;
      } catch (err) {
        // Never block sign-in on org resolution; the engine treats a missing
        // orgId as "legacy token" and the next sign-in will retry.
        console.error("[auth] failed to resolve orgId at sign-in", err);
      }
    }
  }
  return token;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- DrizzleAdapter types conflict between drizzle-orm versions (engine 0.38 vs web 0.45) */
const drizzleAuthAdapter = DrizzleAdapter(db as any, {
  usersTable: usersTable as any,
  accountsTable: accountsTable as any,
  sessionsTable: sessionsTable as any,
  verificationTokensTable: verificationTokensTable as any,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    jwt: jwtWithOrg,
  },
  events: {
    /**
     * Fired once when the DrizzleAdapter creates a brand-new user (OAuth first
     * sign-in). Provision the default-org membership + Owner binding eagerly so
     * the user is fully set up even before the jwt callback resolves orgId —
     * closing the first-registrant race the migration backfill can't cover.
     */
    async createUser({ user }) {
      if (!user.id) return;
      try {
        await provisionUserDefaultOrg(orgProvisioningPort, user.id);
      } catch (err) {
        console.error("[auth] failed to provision default org for new user", err);
      }
    },
  },
  adapter: drizzleAuthAdapter,
});
