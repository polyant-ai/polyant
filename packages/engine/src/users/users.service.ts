// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  countPlatformAdmins,
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
  type ListUsersQuery,
  type UserList,
} from "./users.store.js";
import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from "./password.util.js";
import { isLastOwnerOfAnyOrg } from "../organizations/members.store.js";
import { generateToken } from "../crypto/index.js";
import { isUniqueViolation } from "../utils/db-errors.js";

// RFC 5321 caps an email address at 254 chars. Enforce it before the regex
// runs so the polynomial-ish backtracking cost of the [^\s@]+ groups can
// never be triggered by an attacker-supplied long string (CodeQL js/polynomial-redos).
const EMAIL_MAX_LEN = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read the platform-admin flag out of a request body.
 *
 * `isPlatformAdmin: boolean` is the only value ever WRITTEN. For ONE release
 * this also accepts the deprecated `role` alias — `"platform_admin"` / the
 * pre-rename `"superadmin"` / `"user"` — mapped straight into the boolean. The
 * two-spelling comparison below is inlined from the now-deleted
 * `auth/user-role.ts` compatibility shim: this is the LAST place either
 * spelling is recognised. It is a wire alias in scheduled retirement, never a
 * persisted fact — nothing here writes `role` back.
 *
 * Returns `undefined` when the caller sent neither field, which the create and
 * update paths interpret differently: create defaults to `false` (an ordinary
 * user), update treats it as "leave the flag untouched".
 */
function readPlatformAdminFlag(body: {
  isPlatformAdmin?: boolean;
  role?: string;
}): boolean | undefined {
  if (typeof body.isPlatformAdmin === "boolean") return body.isPlatformAdmin;
  if (body.isPlatformAdmin !== undefined) {
    // There is no DTO validation on this route — NestJS erases the controller's
    // parameter type at runtime — so a non-boolean would flow straight through
    // to Postgres. `"off"` is truthy here and false there: the
    // last-platform-admin guard would see no demotion and the DB would perform
    // one, leaving the deployment with zero platform admins.
    throw new BadRequestException("isPlatformAdmin must be a boolean");
  }
  if (body.role !== undefined) {
    const isPlatformAdminRole = body.role === "platform_admin" || body.role === "superadmin";
    if (body.role !== "user" && !isPlatformAdminRole) {
      throw new BadRequestException("Invalid role: expected 'platform_admin' or 'user'");
    }
    return isPlatformAdminRole;
  }
  return undefined;
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
  async list(query: ListUsersQuery): Promise<UserList> {
    return listUsers(query);
  }

  async get(id: string): Promise<PublicUser> {
    const found = await getUserById(id);
    if (!found) throw new NotFoundException(`User ${id} not found`);
    return stripSecret(found);
  }

  async create(body: {
    email?: string;
    name?: string;
    /** @deprecated wire alias for `isPlatformAdmin`, scheduled for retirement — see readPlatformAdminFlag */
    role?: string;
    isPlatformAdmin?: boolean;
    password?: string;
  }): Promise<CreateUserResult> {
    const email = (body.email ?? "").trim().toLowerCase();
    if (email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) {
      throw new BadRequestException("Invalid email");
    }
    const isPlatformAdmin = readPlatformAdminFlag(body) ?? false;

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
        isPlatformAdmin,
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
    body: { name?: string | null; role?: string; isPlatformAdmin?: boolean },
    actor: { userId: string },
  ): Promise<PublicUser> {
    const target = await getUserById(id);
    if (!target) throw new NotFoundException(`User ${id} not found`);

    const nextFlag = readPlatformAdminFlag(body);
    if (nextFlag !== undefined) {
      // Prevent removing the last platform admin (also blocks self-demotion if
      // you're the only one). `target.isPlatformAdmin` IS the standing now —
      // there is no second, role-derived source to fall back on.
      if (target.isPlatformAdmin && !nextFlag) {
        const count = await countPlatformAdmins();
        if (count <= 1) {
          throw new ConflictException(
            "Cannot remove the last platform admin: promote another user first.",
          );
        }
      }
    }

    const updated = await updateUserMeta(id, {
      name: body.name === undefined ? undefined : body.name,
      isPlatformAdmin: nextFlag,
    });
    if (!updated) throw new NotFoundException(`User ${id} not found`);

    // If the standing changed for someone else, invalidate their DB sessions.
    // (JWE stays valid until expiry — known trade-off.)
    if (nextFlag !== undefined && nextFlag !== target.isPlatformAdmin && actor.userId !== id) {
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

    // Same standing test as `update`: the enforced flag, and only the flag.
    if (target.isPlatformAdmin) {
      const count = await countPlatformAdmins();
      if (count <= 1) {
        throw new ConflictException("Cannot delete the last platform admin");
      }
    }

    // Owner-last guard: a user-delete cascades their role bindings, so deleting
    // the sole Owner of an organization would orphan it (same protection the
    // RoleBindingService enforces on a direct binding removal).
    if (await isLastOwnerOfAnyOrg(id)) {
      throw new ConflictException(
        "Cannot delete the last Owner of an organization: assign another Owner first.",
      );
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
