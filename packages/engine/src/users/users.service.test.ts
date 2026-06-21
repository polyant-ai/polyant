// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

// Mock the data store: every test injects its own behavior.
vi.mock("./users.store.js", () => ({
  countSuperadmins: vi.fn(),
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
    role: "user" as const,
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
    it("refuses to demote the last remaining superadmin", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "sa", role: "superadmin" }),
      );
      mocked.countSuperadmins.mockResolvedValueOnce(1);

      await expect(
        service.update(
          "sa",
          { role: "user" },
          { userId: "other", role: "superadmin" },
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocked.updateUserMeta).not.toHaveBeenCalled();
    });

    it("allows demoting a superadmin when more than one exists", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "sa1", role: "superadmin" }),
      );
      mocked.countSuperadmins.mockResolvedValueOnce(2);
      mocked.updateUserMeta.mockResolvedValueOnce(
        makeUser({ id: "sa1", role: "user" }),
      );

      await service.update(
        "sa1",
        { role: "user" },
        { userId: "actor", role: "superadmin" },
      );
      expect(mocked.updateUserMeta).toHaveBeenCalledWith("sa1", expect.objectContaining({ role: "user" }));
      // Role changed for someone else → DB sessions invalidated.
      expect(mocked.deleteSessionsForUser).toHaveBeenCalledWith("sa1");
    });

    it("returns 404 when the target user does not exist", async () => {
      mocked.getUserById.mockResolvedValueOnce(null);
      await expect(
        service.update("missing", { name: "X" }, { userId: "actor", role: "superadmin" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("does NOT invalidate sessions when the actor edits their own row", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "self", role: "superadmin" }),
      );
      mocked.countSuperadmins.mockResolvedValueOnce(2);
      mocked.updateUserMeta.mockResolvedValueOnce(
        makeUser({ id: "self", role: "user" }),
      );

      await service.update(
        "self",
        { role: "user" },
        { userId: "self", role: "superadmin" },
      );
      expect(mocked.deleteSessionsForUser).not.toHaveBeenCalled();
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

    it("blocks deleting the last superadmin", async () => {
      mocked.getUserById.mockResolvedValueOnce(
        makeUser({ id: "sa", role: "superadmin" }),
      );
      mocked.countSuperadmins.mockResolvedValueOnce(1);

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
        makeUser({ id: "u", passwordHash: hash, hasPassword: true, role: "superadmin" }),
      );
      const res = await service.verifyCredentials("a@b.com", "right-pwd-9999");
      expect(res).not.toBeNull();
      expect(res?.role).toBe("superadmin");
      expect((res as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    });

    it("accepts no-TLD emails like 'administrator@local' (seeded admin)", async () => {
      // Earlier the verify branch rejected such emails via a regex, breaking
      // the default seeded admin. Regression guard.
      const hash = await hashPassword("seed-admin-pwd");
      mocked.getUserByEmail.mockResolvedValueOnce(
        makeUser({ email: "administrator@local", passwordHash: hash, hasPassword: true, role: "superadmin" }),
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
