// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { users, sessions, type UserRole } from "../auth/users.schema.js";

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

export async function listUsers(): Promise<UserRow[]> {
  const rows = await db.select().from(users).orderBy(users.createdAt);
  return rows.map((r) => stripSecret(mapRow(r)));
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

export async function countSuperadmins(): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, "superadmin"));
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
      // Keep the platform-admin bypass in lockstep with the superadmin role at
      // the write boundary, so a fresh-install superadmin gets the bypass without
      // depending on PLATFORM_ADMIN_EMAIL (mirrors migration 0051's backfill).
      isPlatformAdmin: input.role === "superadmin",
      mustChangePassword: input.mustChangePassword,
    })
    .returning();
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
    // Role and platform-admin bypass move together: promoting to superadmin
    // grants it, demoting revokes it.
    patch.isPlatformAdmin = input.role === "superadmin";
  }

  const [row] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, id))
    .returning();
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
  return !!row;
}

/** Forces re-login by invalidating all DB-backed sessions for the user.
 * Note: with JWT session strategy in Auth.js the existing JWE remains valid
 * until expiry — this is documented in CLAUDE.md as a known trade-off. */
export async function deleteSessionsForUser(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
