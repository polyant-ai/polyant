// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

// Mock the data store: every test injects its own behavior.
vi.mock("./users.store.js", () => ({
  countPlatformAdmins: vi.fn(),
  deleteSessionsForUser: vi.fn(),
  deleteUserById: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  insertUser: vi.fn(),
  listUsers: vi.fn(),
  stripSecret: vi.fn((u: Record<string, unknown>) => {
    const copy = { ...u };
    delete copy.passwordHash;
    return copy;
  }),
  updateUserMeta: vi.fn(),
  updateUserPassword: vi.fn(),
}));

// generateToken: deterministic so we can assert on the password we hand back.
vi.mock("../crypto/index.js", () => ({
  generateToken: vi.fn(() => "deadbeef0"),
}));

// Owner-last guard on the user-delete path delegates to the members store.
const { mockIsLastOwnerOfAnyOrg } = vi.hoisted(() => ({
  mockIsLastOwnerOfAnyOrg: vi.fn(),
}));
vi.mock("../organizations/members.store.js", () => ({
  isLastOwnerOfAnyOrg: mockIsLastOwnerOfAnyOrg,
}));

import * as store from "./users.store.js";
import { hashPassword } from "./password.util.js";
import { UsersService } from "./users.service.js";

const mocked = store as unknown as Record<string, ReturnType<typeof vi.fn>>;

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "u-1",
    email: "alice@example.com",
    name: "Alice",
    image: null,
    isPlatformAdmin: false,
    mustChangePassword: false,
    hasPassword: true,
    passwordHash: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("UsersService", () => {
  let service: UsersService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: deleting a user does not orphan any organization's ownership.
    mockIsLastOwnerOfAnyOrg.mockResolvedValue(false);
    service = new UsersService();
  });

  // ---- create -----------------------------------------------------------

  describe("create", () => {
    it("rejects malformed emails with BadRequestException", async () => {
      await expect(service.create({ email: "not-an-email" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocked.insertUser).not.toHaveBeenCalled();
    });

    it("rejects invalid roles", async () => {
      await expect(
        service.create({ email: "x@y.com", role: "godmode" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("generates a password and returns it once when none is provided", async () => {
      mocked.insertUser.mockResolvedValueOnce(
        makeUser({ email: "new@example.com", mustChangePassword: true }),
      );

      const res = await service.create({ email: "new@example.com" });

      expect(res.generatedPassword).toBe("deadbeef0");
      const insertedHash = mocked.insertUser.mock.calls[0][0].passwordHash as string;
      // bcrypt hashes start with $2a/$2b/$2y depending on lib version
      expect(insertedHash).toMatch(/^\$2[aby]\$/);
      expect(mocked.insertUser.mock.calls[0][0].mustChangePassword).toBe(true);
    });

    it("creates a platform admin from isPlatformAdmin", async () => {
      mocked.insertUser.mockResolvedValueOnce(
        makeUser({ email: "a@b.c", isPlatformAdmin: true }),
      );

      const { user } = await service.create({
        email: "a@b.c",
        password: "supplied-pwd-1",
        isPlatformAdmin: true,
      });

      expect(user.isPlatformAdmin).toBe(true);
      expect(user).not.toHaveProperty("role");
      expect(mocked.insertUser.mock.calls[0][0].isPlatformAdmin).toBe(true);
    });

    it("still accepts the deprecated role alias on input for one release", async () => {
      mocked.insertUser.mockResolvedValueOnce(
        makeUser({ email: "d@e.f", isPlatformAdmin: true }),
      );

      const { user } = await service.create({
        email: "d@e.f",
        password: "supplied-pwd-2",
        role: "platform_admin",
      });

      expect(user.isPlatformAdmin).toBe(true);
      expect(mocked.insertUser.mock.calls[0][0].isPlatformAdmin).toBe(true);
    });

    it("still accepts the pre-rename 'superadmin' spelling on input", async () => {
      // Pins the legacy spelling now that auth/user-role.ts (the only other
      // place that tested it) is gone: a future edit to the inlined
      // comparison in users.service.ts that drops "superadmin" would demote
      // any legacy client silently, with no other test to catch it.
      mocked.insertUser.mockResolvedValueOnce(
        makeUser({ email: "g@h.i", isPlatformAdmin: true }),
      );

      const { user } = await service.create({
        email: "g@h.i",
        password: "supplied-pwd-3",
        role: "superadmin",
      });

      expect(user.isPlatformAdmin).toBe(true);
      expect(mocked.insertUser.mock.calls[0][0].isPlatformAdmin).toBe(true);
    });

    it("uses the supplied password and does NOT echo it back to the caller", async () => {
      mocked.insertUser.mockResolvedValueOnce(makeUser({ email: "x@y.com" }));

      const res = await service.create({ email: "x@y.com", password: "supplied-pwd" });

      expect(res.generatedPassword).toBeUndefined();
      const inserted = mocked.insertUser.mock.calls[0][0];
      expect(inserted.passwordHash).toMatch(/^\$2[aby]\$/);
    });

    it("rejects passwords shorter than 8 chars", async () => {
      await expect(
        service.create({ email: "x@y.com", password: "short" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocked.insertUser).not.toHaveBeenCalled();
    });

    it("converts a Drizzle-wrapped unique-violation into a 409 ConflictException", async () => {
      // Drizzle 0.45 wraps PostgresError in DrizzleQueryError; the SQLSTATE
      // ends up on err.cause.code, NOT on err.code directly. The previous
      // detection ignored err.cause and the controller surfaced a generic 500.
      const wrapped = new Error("Failed query: insert into users ...");
      (wrapped as Error & { cause?: unknown }).cause = { code: "23505" };
      mocked.insertUser.mockRejectedValueOnce(wrapped);

      await expect(
        service.create({ email: "dup@example.com" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("still detects the legacy un-wrapped unique-violation shape", async () => {
      const direct = Object.assign(new Error("dup"), { code: "23505" });
      mocked.insertUser.mockRejectedValueOnce(direct);

      await expect(
        service.create({ email: "dup@example.com" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("propagates non-unique errors as-is (so they become 500)", async () => {
      const boom = new Error("connection refused");
      mocked.insertUser.mockRejectedValueOnce(boom);

      await expect(service.create({ email: "x@y.com" })).rejects.toBe(boom);
    });
  });

  // ---- update -----------------------------------------------------------

  describe("update", () => {
    it("refuses to demote the last remaining platform admin", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "sa", isPlatformAdmin: true }),
      );
      mocked.countPlatformAdmins.mockResolvedValueOnce(1);

      await expect(
        service.update(
          "sa",
          { isPlatformAdmin: false },
          { userId: "other" },
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocked.updateUserMeta).not.toHaveBeenCalled();
    });

    it("allows demoting a platform admin when more than one exists", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "sa1", isPlatformAdmin: true }),
      );
      mocked.countPlatformAdmins.mockResolvedValueOnce(2);
      mocked.updateUserMeta.mockResolvedValueOnce(
        makeUser({ id: "sa1", isPlatformAdmin: false }),
      );

      await service.update(
        "sa1",
        { isPlatformAdmin: false },
        { userId: "actor" },
      );
      expect(mocked.updateUserMeta).toHaveBeenCalledWith(
        "sa1",
        expect.objectContaining({ isPlatformAdmin: false }),
      );
      // Standing changed for someone else → DB sessions invalidated.
      expect(mocked.deleteSessionsForUser).toHaveBeenCalledWith("sa1");
    });

    it("returns 404 when the target user does not exist", async () => {
      mocked.getUserById.mockResolvedValueOnce(null);
      await expect(
        service.update("missing", { name: "X" }, { userId: "actor" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("does NOT invalidate sessions when the actor edits their own row", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "self", isPlatformAdmin: true }),
      );
      mocked.countPlatformAdmins.mockResolvedValueOnce(2);
      mocked.updateUserMeta.mockResolvedValueOnce(
        makeUser({ id: "self", isPlatformAdmin: false }),
      );

      await service.update(
        "self",
        { isPlatformAdmin: false },
        { userId: "self" },
      );
      expect(mocked.deleteSessionsForUser).not.toHaveBeenCalled();
    });

    it("still accepts the deprecated role alias on a PATCH", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "u2", isPlatformAdmin: false }),
      );
      mocked.updateUserMeta.mockResolvedValueOnce(
        makeUser({ id: "u2", isPlatformAdmin: true }),
      );

      await service.update("u2", { role: "platform_admin" }, { userId: "actor" });

      expect(mocked.updateUserMeta).toHaveBeenCalledWith(
        "u2",
        expect.objectContaining({ isPlatformAdmin: true }),
      );
    });

    it("still accepts the pre-rename 'superadmin' spelling on a PATCH", async () => {
      // Pins the legacy spelling on the update path too — see the sibling
      // "superadmin" case under create for why this must not silently regress.
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "u3", isPlatformAdmin: false }),
      );
      mocked.updateUserMeta.mockResolvedValueOnce(
        makeUser({ id: "u3", isPlatformAdmin: true }),
      );

      await service.update("u3", { role: "superadmin" }, { userId: "actor" });

      expect(mocked.updateUserMeta).toHaveBeenCalledWith(
        "u3",
        expect.objectContaining({ isPlatformAdmin: true }),
      );
    });

    it("rejects a non-boolean isPlatformAdmin instead of coercing it", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "u4", isPlatformAdmin: false }),
      );

      await expect(
        service.update(
          "u4",
          { isPlatformAdmin: "true" as unknown as boolean },
          { userId: "actor" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocked.updateUserMeta).not.toHaveBeenCalled();
    });

    it("cannot demote the last platform admin with a truthy non-boolean", async () => {
      // `"off"` is truthy in JS and false in Postgres: without the runtime type
      // check the guard below sees "no demotion" while the DB performs one,
      // leaving the deployment with zero platform admins. There is no DTO
      // validation on this route, so the service is the only place to catch it.
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "sa", isPlatformAdmin: true }),
      );

      await expect(
        service.update(
          "sa",
          { isPlatformAdmin: "off" as unknown as boolean },
          { userId: "actor" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocked.countPlatformAdmins).not.toHaveBeenCalled();
      expect(mocked.updateUserMeta).not.toHaveBeenCalled();
    });
  });

  // ---- remove -----------------------------------------------------------

  describe("remove", () => {
    it("blocks self-deletion", async () => {
      await expect(
        service.remove("me", { userId: "me" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocked.deleteUserById).not.toHaveBeenCalled();
    });

    it("blocks deleting the last platform admin", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "sa", isPlatformAdmin: true }),
      );
      mocked.countPlatformAdmins.mockResolvedValueOnce(1);

      await expect(
        service.remove("sa", { userId: "other" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocked.deleteUserById).not.toHaveBeenCalled();
    });

    it("blocks deleting the last Owner of an organization", async () => {
      mocked.getUserById.mockResolvedValueOnce(makeUser({ id: "owner" }));
      mockIsLastOwnerOfAnyOrg.mockResolvedValueOnce(true);

      await expect(
        service.remove("owner", { userId: "other" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockIsLastOwnerOfAnyOrg).toHaveBeenCalledWith("owner");
      expect(mocked.deleteUserById).not.toHaveBeenCalled();
    });

    it("invalidates sessions before deleting", async () => {
      mocked.getUserById.mockResolvedValueOnce(makeUser({ id: "u" }));
      mocked.deleteUserById.mockResolvedValueOnce(true);

      await service.remove("u", { userId: "actor" });

      expect(mocked.deleteSessionsForUser).toHaveBeenCalledWith("u");
      expect(mocked.deleteUserById).toHaveBeenCalledWith("u");
      // Order matters: sessions wiped first so the user can't keep using a stale
      // refresh while the row is gone.
      const sessIdx = mocked.deleteSessionsForUser.mock.invocationCallOrder[0];
      const delIdx = mocked.deleteUserById.mock.invocationCallOrder[0];
      expect(sessIdx).toBeLessThan(delIdx);
    });
  });

  // ---- resetPassword ----------------------------------------------------

  describe("resetPassword", () => {
    it("generates a new password, sets must_change, and surfaces it once", async () => {
      mocked.getUserById
        .mockResolvedValueOnce(makeUser({ id: "u" }))
        .mockResolvedValueOnce(makeUser({ id: "u", mustChangePassword: true }));
      mocked.updateUserPassword.mockResolvedValueOnce(true);

      const res = await service.resetPassword("u");

      expect(res.generatedPassword).toBe("deadbeef0");
      expect(mocked.updateUserPassword).toHaveBeenCalledWith(
        "u",
        expect.stringMatching(/^\$2[aby]\$/),
        true, // must_change_password
      );
      // Reset always invalidates active sessions.
      expect(mocked.deleteSessionsForUser).toHaveBeenCalledWith("u");
    });

    it("returns 404 when the target does not exist", async () => {
      mocked.getUserById.mockResolvedValueOnce(null);
      await expect(service.resetPassword("ghost")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---- changeOwnPassword ------------------------------------------------

  describe("changeOwnPassword", () => {
    it("rejects passwords shorter than 8 chars", async () => {
      mocked.getUserById.mockResolvedValueOnce(makeUser({ id: "u" }));
      await expect(
        service.changeOwnPassword(
          { userId: "u" },
          { currentPassword: "anything", newPassword: "short" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("requires currentPassword when not in mustChange mode", async () => {
      const hash = await hashPassword("real-current-pwd");
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "u", passwordHash: hash, hasPassword: true }),
      );

      await expect(
        service.changeOwnPassword(
          { userId: "u" },
          { currentPassword: "wrong-current", newPassword: "brand-new-pwd" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("skips currentPassword check when mustChangePassword is true", async () => {
      const hash = await hashPassword("temp-pwd-1234");
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({
          id: "u",
          passwordHash: hash,
          hasPassword: true,
          mustChangePassword: true,
        }),
      );
      mocked.updateUserPassword.mockResolvedValueOnce(true);

      await service.changeOwnPassword(
        { userId: "u" },
        { newPassword: "fresh-new-pwd" },
      );

      expect(mocked.updateUserPassword).toHaveBeenCalledWith(
        "u",
        expect.stringMatching(/^\$2[aby]\$/),
        false, // must_change_password reset
      );
    });

    it("rejects setting the same password as the current one (forced flow too)", async () => {
      const hash = await hashPassword("temporary-pwd");
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({
          id: "u",
          passwordHash: hash,
          hasPassword: true,
          mustChangePassword: true,
        }),
      );

      await expect(
        service.changeOwnPassword(
          { userId: "u" },
          { newPassword: "temporary-pwd" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocked.updateUserPassword).not.toHaveBeenCalled();
    });

    it("rejects same-as-current also in non-forced mode", async () => {
      const hash = await hashPassword("user-chosen-old");
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "u", passwordHash: hash, hasPassword: true }),
      );

      await expect(
        service.changeOwnPassword(
          { userId: "u" },
          { currentPassword: "user-chosen-old", newPassword: "user-chosen-old" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ---- verifyCredentials ------------------------------------------------

  describe("verifyCredentials", () => {
    it("returns null on unknown email", async () => {
      mocked.getUserByEmail.mockResolvedValueOnce(null);
      expect(
        await service.verifyCredentials("ghost@nowhere.local", "any"),
      ).toBeNull();
    });

    it("returns null when user exists but has no password (OAuth-only)", async () => {
      mocked.getUserByEmail.mockResolvedValueOnce(
        makeUser({ passwordHash: null, hasPassword: false }),
      );
      expect(await service.verifyCredentials("a@b.com", "guess")).toBeNull();
    });

    it("returns null on wrong password", async () => {
      const hash = await hashPassword("real-pwd-1234");
      mocked.getUserByEmail.mockResolvedValueOnce(
        makeUser({ passwordHash: hash, hasPassword: true }),
      );
      expect(await service.verifyCredentials("a@b.com", "wrong-guess")).toBeNull();
    });

    it("returns the public user (no passwordHash) on a correct password", async () => {
      const hash = await hashPassword("right-pwd-9999");
      mocked.getUserByEmail.mockResolvedValueOnce(
        makeUser({ id: "u", passwordHash: hash, hasPassword: true, isPlatformAdmin: true }),
      );
      const res = await service.verifyCredentials("a@b.com", "right-pwd-9999");
      expect(res).not.toBeNull();
      expect(res?.isPlatformAdmin).toBe(true);
      expect(res).not.toHaveProperty("role");
      expect((res as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    });

    it("accepts no-TLD emails like 'administrator@local' (seeded admin)", async () => {
      // Earlier the verify branch rejected such emails via a regex, breaking
      // the default seeded admin. Regression guard.
      const hash = await hashPassword("seed-admin-pwd");
      mocked.getUserByEmail.mockResolvedValueOnce(
        makeUser({ email: "administrator@local", passwordHash: hash, hasPassword: true, isPlatformAdmin: true }),
      );
      const res = await service.verifyCredentials("administrator@local", "seed-admin-pwd");
      expect(res).not.toBeNull();
      expect(res?.email).toBe("administrator@local");
    });

    it("returns null on empty inputs (defensive)", async () => {
      expect(await service.verifyCredentials("", "x")).toBeNull();
    });
  });
});
