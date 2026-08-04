// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, sql , inArray , desc } from "drizzle-orm";
import { db } from "../database/client.js";
import { users, sessions, type UserRole } from "../auth/users.schema.js";
import { invalidateSuperadminCache } from "../authz/authz.caches.js";
import { PLATFORM_ADMIN_ROLE_VALUES, isPlatformAdminRole } from "../auth/user-role.js";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: UserRole;
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface UserWithSecret extends UserRow {
  passwordHash: string | null;
}

function mapRow(row: typeof users.$inferSelect): UserWithSecret {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    image: row.image ?? null,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
    hasPassword: row.passwordHash !== null,
    passwordHash: row.passwordHash ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function stripSecret(row: UserWithSecret): UserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
    hasPassword: row.hasPassword,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ListUsersQuery {
  readonly limit: number;
  readonly offset: number;
}

export interface UserList {
  readonly users: UserRow[];
  readonly total: number;
}

/**
 * One page of installation accounts, plus the total.
 *
 * PAGINATED because it was not: the previous form selected the whole `users`
 * table with no LIMIT, so the response grew with the installation and the panel
 * rendered every row it was sent.
 *
 * Ordered platform-admins-first, then by email, rather than by creation date: the
 * flag is the reason to open this list, and burying admins among the accounts
 * created around them defeats its purpose. Tolerant of BOTH role values, like
 * every other read — a row still holding the legacy spelling is just as much a
 * platform admin, and ordering on the canonical value alone would sort it in with
 * ordinary users.
 */
export async function listUsers(query: ListUsersQuery): Promise<UserList> {
  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(users)
      .orderBy(
        // The column is typed on what we WRITE, while the stored set is wider by
        // one legacy value — the same cast `countPlatformAdmins` needs.
        desc(inArray(users.role, [...PLATFORM_ADMIN_ROLE_VALUES] as UserRole[])),
        users.email,
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(users),
  ]);
  return {
    users: rows.map((r) => stripSecret(mapRow(r))),
    total: totalRows[0]?.count ?? 0,
  };
}

export { stripSecret };

export async function getUserById(id: string): Promise<UserWithSecret | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ? mapRow(row) : null;
}

export async function getUserByEmail(email: string): Promise<UserWithSecret | null> {
  const normalized = email.trim().toLowerCase();
  const [row] = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  return row ? mapRow(row) : null;
}

export async function countUsers(): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  return count ?? 0;
}

/**
 * How many accounts hold platform-admin standing. Matches BOTH spellings, and
 * that is the load-bearing part: undercounting is what would let the LAST
 * platform admin be demoted or deleted, locking the deployment out of its own
 * administration. The column is typed on what we WRITE, while the stored set is
 * wider by one legacy value, hence the cast.
 */
export async function countPlatformAdmins(): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(inArray(users.role, [...PLATFORM_ADMIN_ROLE_VALUES] as UserRole[]));
  return count ?? 0;
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  passwordHash: string | null;
  role: UserRole;
  mustChangePassword: boolean;
}

export async function insertUser(input: CreateUserInput): Promise<UserWithSecret> {
  const [row] = await db
    .insert(users)
    .values({
      email: input.email.trim().toLowerCase(),
      name: input.name?.trim() || null,
      passwordHash: input.passwordHash,
      role: input.role,
      // Keep the platform-admin bypass in lockstep with the role at the write
      // boundary — through the PREDICATE, so an API caller still POSTing the
      // legacy value is still granted the flag rather than silently not being an
      // admin. A fresh install gets the bypass without
      // depending on PLATFORM_ADMIN_EMAIL (mirrors migration 0051's backfill).
      isPlatformAdmin: isPlatformAdminRole(input.role),
      mustChangePassword: input.mustChangePassword,
    })
    .returning();
  // A brand-new id cannot hold a stale entry, but pairing EVERY write of the
  // flag with an invalidation keeps the invariant grep-verifiable instead of
  // requiring each call site to re-prove the negative.
  invalidateSuperadminCache(row.id);
  return mapRow(row);
}

export interface UpdateUserInput {
  name?: string | null;
  role?: UserRole;
}

export async function updateUserMeta(
  id: string,
  input: UpdateUserInput,
): Promise<UserWithSecret | null> {
  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.name !== undefined) patch.name = input.name?.trim() || null;
  if (input.role !== undefined) {
    patch.role = input.role;
    // Role and platform-admin bypass move together: promoting to platform admin
    // grants it, demoting revokes it.
    patch.isPlatformAdmin = isPlatformAdminRole(input.role);
  }

  const [row] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, id))
    .returning();
  // Flush AFTER the write commits: invalidating first would let a concurrent
  // read repopulate the cache with the pre-update value.
  if (input.role !== undefined) invalidateSuperadminCache(id);
  return row ? mapRow(row) : null;
}

export async function updateUserPassword(
  id: string,
  passwordHash: string,
  mustChangePassword: boolean,
): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return !!row;
}

export async function deleteUserById(id: string): Promise<boolean> {
  const [row] = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
  // Dropping the row clears the flag too. Without this a deleted platform admin
  // keeps the bypass for the rest of the TTL — their JWE outlives the row
  // (documented Auth.js trade-off), so the guard would still see a principal.
  invalidateSuperadminCache(id);
  return !!row;
}

/** Forces re-login by invalidating all DB-backed sessions for the user.
 * Note: with JWT session strategy in Auth.js the existing JWE remains valid
 * until expiry — this is documented in CLAUDE.md as a known trade-off. */
export async function deleteSessionsForUser(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
