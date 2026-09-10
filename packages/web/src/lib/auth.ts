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
import { eq } from "drizzle-orm";
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
import { databaseSslFromEnv, databaseUrlFromEnv } from "./db-url";
import {
  resolveSignInOrgId,
  type OrgProvisioningPort,
} from "./org-provisioning";

// Aurora/managed Postgres rejects unencrypted connections (pg_hba "no
// encryption"), so TLS follows POSTGRES_SSL and accepts the managed CA chain.
// Both rules live in db-url.ts — see the note there on why the panel keeps its
// own copy of the engine's assembly.
const queryClient = postgres(databaseUrlFromEnv(), { ssl: databaseSslFromEnv() });
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
 * RBAC tenancy tables (subset). The Node-side Auth.js callback resolves a user's
 * organization at sign-in and writes nothing at all: the `organizations`, `roles`
 * and `role_bindings` mirrors went with the auto-provisioning that needed them,
 * and the one remaining write — the configured platform admin's owner bootstrap,
 * delegated to the engine over its internal channel — went with
 * `PLATFORM_ADMIN_EMAIL`. Sign-in is a membership lookup, and nothing else.
 */
const organizationMembershipsTable = pgTable("organization_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
});

/**
 * Concrete {@link OrgProvisioningPort} backed by the postgres-js Drizzle client.
 * The orchestration lives in `org-provisioning.ts` (unit tested); this is the
 * thin SQL adapter, and it is read-only. Membership is granted deliberately
 * through the members API, never as a side effect of authenticating.
 */
const orgProvisioningPort: OrgProvisioningPort = {
  async findUserOrgId(userId) {
    const [row] = await db
      .select({ id: organizationMembershipsTable.organizationId })
      .from(organizationMembershipsTable)
      .where(eq(organizationMembershipsTable.userId, userId))
      .limit(1);
    return row?.id ?? null;
  },
};

/**
 * The Edge-safe `jwt` callback (from `auth.config.ts`) handles isPlatformAdmin /
 * mustChangePassword. Here in the Node context we additionally resolve and
 * stamp `orgId` at sign-in, which requires DB access the Edge runtime can't do.
 * `orgId` is resolved only on the first call (when `user` is present) and then
 * persisted on the token for subsequent requests. It is NEVER accepted from a
 * client `update` patch — same hardening rationale as `isPlatformAdmin`.
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
        const orgId = await resolveSignInOrgId(orgProvisioningPort, { userId });
        if (orgId) token.orgId = orgId;
      } catch (err) {
        // Never block sign-in on org resolution. A missing orgId is not an error
        // state to recover from by signing in again — a user who holds no
        // membership genuinely belongs to no organization until an admin adds
        // them, and the panel says exactly that.
        console.error("[auth] failed to resolve orgId at sign-in", err);
      }
    }
  }
  return token;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- @auth/drizzle-adapter expects its own schema shape, which does not line up with the engine-owned tables */
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
    // No `signIn` callback, and nothing left for one to decide: this edition
    // offers no federated provider (`auth-providers.ts`), so every sign-in is a
    // password sign-in the engine has already verified. The callback used to
    // refuse a federated sign-in whose email domain was outside
    // `AUTH_ALLOWED_DOMAIN(S)` — one list for a whole installation, which cannot
    // answer the question for a second tenant. Both the list and the provider it
    // gated belong to the tier that manages organizations.
  },
  // No `events.createUser`. It used to provision the default-org membership and
  // the OWNER binding the moment the adapter created a user, so a first OAuth
  // sign-in made you an Owner of the organization — the highest role in the
  // product, granted for having an address that passed the domain allowlist.
  //
  // A new user is now created and left with no membership. Someone holding
  // `org.member:manage` adds them through
  // `PUT /api/organizations/:orgSlug/members/:userId`, which writes the membership
  // and the role binding together and therefore decides what role they get.
  adapter: drizzleAuthAdapter,
});
