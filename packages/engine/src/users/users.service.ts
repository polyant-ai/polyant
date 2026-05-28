// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  countSuperadmins,
  deleteSessionsForUser,
  deleteUserById,
  getUserByEmail,
  getUserById,
  insertUser,
  listUsers,
  stripSecret,
  updateUserMeta,
  updateUserPassword,
  type UserRow,
} from "./users.store.js";
import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from "./password.util.js";
import type { UserRole } from "../auth/users.schema.js";
import { generateToken } from "../crypto/index.js";
import { isUniqueViolation } from "../utils/db-errors.js";

// RFC 5321 caps an email address at 254 chars. Enforce it before the regex
// runs so the polynomial-ish backtracking cost of the [^\s@]+ groups can
// never be triggered by an attacker-supplied long string (CodeQL js/polynomial-redos).
const EMAIL_MAX_LEN = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validRole(value: unknown): UserRole {
  if (value === "superadmin" || value === "user") return value;
  throw new BadRequestException("Invalid role: expected 'superadmin' or 'user'");
}

export type PublicUser = UserRow;

export interface CreateUserResult {
  user: PublicUser;
  /** Set when the caller did NOT provide a password — admin must communicate it out-of-band. */
  generatedPassword?: string;
}

export interface ResetPasswordResult {
  user: PublicUser;
  generatedPassword: string;
}

@Injectable()
export class UsersService {
  async list(): Promise<PublicUser[]> {
    return listUsers();
  }

  async get(id: string): Promise<PublicUser> {
    const found = await getUserById(id);
    if (!found) throw new NotFoundException(`User ${id} not found`);
    return stripSecret(found);
  }

  async create(body: {
    email?: string;
    name?: string;
    role?: string;
    password?: string;
  }): Promise<CreateUserResult> {
    const email = (body.email ?? "").trim().toLowerCase();
    if (email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) {
      throw new BadRequestException("Invalid email");
    }
    const role = validRole(body.role ?? "user");

    let plain = body.password?.trim();
    let generated: string | undefined;
    if (!plain) {
      // 18 hex chars = 9 bytes — short enough to be readable, long enough for randomness.
      generated = generateToken(9);
      plain = generated;
    }

    const validation = validatePassword(plain);
    if (validation) throw new BadRequestException(validation.message);

    const passwordHash = await hashPassword(plain);

    try {
      const created = await insertUser({
        email,
        name: body.name?.trim() || null,
        passwordHash,
        role,
        mustChangePassword: true,
      });
      return { user: stripSecret(created), generatedPassword: generated };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A user with email ${email} already exists`);
      }
      throw err;
    }
  }

  async update(
    id: string,
    body: { name?: string | null; role?: string },
    actor: { userId: string; role: UserRole },
  ): Promise<PublicUser> {
    const target = await getUserById(id);
    if (!target) throw new NotFoundException(`User ${id} not found`);

    let nextRole: UserRole | undefined;
    if (body.role !== undefined) {
      nextRole = validRole(body.role);
      // Prevent removing the last superadmin (also blocks self-demotion if you're the only one).
      if (target.role === "superadmin" && nextRole !== "superadmin") {
        const count = await countSuperadmins();
        if (count <= 1) {
          throw new ConflictException(
            "Cannot remove the last superadmin: promote another user first.",
          );
        }
      }
    }

    const updated = await updateUserMeta(id, {
      name: body.name === undefined ? undefined : body.name,
      role: nextRole,
    });
    if (!updated) throw new NotFoundException(`User ${id} not found`);

    // If the role changed for someone else, invalidate their DB sessions.
    // (JWE stays valid until expiry — known trade-off.)
    if (nextRole && nextRole !== target.role && actor.userId !== id) {
      await deleteSessionsForUser(id);
    }

    return stripSecret(updated);
  }

  async remove(id: string, actor: { userId: string }): Promise<void> {
    if (actor.userId === id) {
      throw new ConflictException("You cannot delete yourself");
    }
    const target = await getUserById(id);
    if (!target) throw new NotFoundException(`User ${id} not found`);

    if (target.role === "superadmin") {
      const count = await countSuperadmins();
      if (count <= 1) {
        throw new ConflictException("Cannot delete the last superadmin");
      }
    }

    await deleteSessionsForUser(id);
    const ok = await deleteUserById(id);
    if (!ok) throw new NotFoundException(`User ${id} not found`);
  }

  async resetPassword(id: string): Promise<ResetPasswordResult> {
    const target = await getUserById(id);
    if (!target) throw new NotFoundException(`User ${id} not found`);

    const generated = generateToken(9);
    const passwordHash = await hashPassword(generated);
    await updateUserPassword(id, passwordHash, true);
    await deleteSessionsForUser(id);

    const refreshed = await getUserById(id);
    if (!refreshed) throw new NotFoundException(`User ${id} not found`);
    return { user: stripSecret(refreshed), generatedPassword: generated };
  }

  async changeOwnPassword(
    actor: { userId: string },
    body: { currentPassword?: string; newPassword?: string },
  ): Promise<void> {
    const target = await getUserById(actor.userId);
    if (!target) throw new NotFoundException("User not found");

    const newPassword = body.newPassword?.trim() ?? "";
    const validation = validatePassword(newPassword);
    if (validation) throw new BadRequestException(validation.message);

    // currentPassword is mandatory unless the user has never set a password yet
    // (OAuth-only account adding credentials) or is in mustChangePassword mode.
    const requireCurrent = !target.mustChangePassword && target.hasPassword;
    if (requireCurrent) {
      const ok =
        target.passwordHash != null &&
        (await verifyPassword(body.currentPassword ?? "", target.passwordHash));
      if (!ok) {
        throw new BadRequestException("Password attuale non corretta");
      }
    }

    // Reject reusing the same password. Especially important for the forced
    // change flow (must_change_password = true): the admin set a temporary
    // password the user knows; pretending to "change" it back to the same
    // value would defeat the rotation.
    if (target.passwordHash) {
      const sameAsCurrent = await verifyPassword(newPassword, target.passwordHash);
      if (sameAsCurrent) {
        throw new BadRequestException(
          "The new password must differ from the previous one",
        );
      }
    }

    const hash = await hashPassword(newPassword);
    await updateUserPassword(actor.userId, hash, false);
  }

  async verifyCredentials(
    email: string,
    password: string,
  ): Promise<PublicUser | null> {
    // No regex check here on purpose: this path is gated by a successful
    // bcrypt match against a stored hash. Validating the format would only
    // reject legitimate seeded accounts like "administrator@local" (no TLD).
    const normalized = (email ?? "").trim().toLowerCase();
    if (!normalized) return null;

    const found = await getUserByEmail(normalized);
    if (!found || !found.passwordHash) return null;

    const ok = await verifyPassword(password ?? "", found.passwordHash);
    if (!ok) return null;

    return stripSecret(found);
  }
}
