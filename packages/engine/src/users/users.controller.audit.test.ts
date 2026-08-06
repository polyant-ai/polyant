// SPDX-License-Identifier: AGPL-3.0-or-later

// Privilege-granting mutations on the /api/users surface must leave a
// management-audit row carrying actor + target + action. Neither a password nor a
// generated password is ever audited.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditLog } = vi.hoisted(() => ({ mockAuditLog: vi.fn() }));

vi.mock("../management-audit/management-audit-logger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../management-audit/management-audit-logger.js")>();
  return { ...actual, createManagementAuditLogger: () => ({ log: mockAuditLog }) };
});

import { UsersController } from "./users.controller.js";
import { ManagementAuditAction } from "../management-audit/management-audit-logger.js";

const actor = {
  userId: "admin-1",
  email: "admin@example.com",
  role: "platform_admin",
} as const;
// The logger deliberately projects the principal to { userId, email } only.
const expectedActor = { userId: "admin-1", email: "admin@example.com" };

function makeController() {
  const users = {
    create: vi.fn().mockResolvedValue({
      user: { id: "u-9", role: "platform_admin" },
      generatedPassword: "hunter2hunter2",
    }),
    update: vi.fn().mockResolvedValue({ id: "u-9", role: "platform_admin" }),
    remove: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi
      .fn()
      .mockResolvedValue({ user: { id: "u-9" }, generatedPassword: "hunter2hunter2" }),
  };
  return { controller: new UsersController(users as never), users };
}

describe("UsersController management audit", () => {
  let ctx: ReturnType<typeof makeController>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeController();
  });

  it("audits user.create with the granted role and never the password", async () => {
    await ctx.controller.create(
      { email: "new@example.com", role: "platform_admin", password: "s3cret-passw0rd" },
      actor as never,
    );

    expect(mockAuditLog).toHaveBeenCalledWith({
      action: ManagementAuditAction.UserCreate,
      actor: expectedActor,
      targetType: "user",
      targetId: "u-9",
      metadata: { role: "platform_admin" },
    });
    expect(JSON.stringify(mockAuditLog.mock.calls)).not.toContain("s3cret-passw0rd");
    expect(JSON.stringify(mockAuditLog.mock.calls)).not.toContain("hunter2hunter2");
  });

  it("audits user.role_update on a role PATCH", async () => {
    await ctx.controller.update("u-9", { role: "platform_admin" }, actor as never);

    expect(mockAuditLog).toHaveBeenCalledWith({
      action: ManagementAuditAction.UserRoleUpdate,
      actor: expectedActor,
      targetType: "user",
      targetId: "u-9",
      metadata: { role: "platform_admin" },
    });
  });

  it("does not audit a name-only PATCH (not privilege-granting)", async () => {
    await ctx.controller.update("u-9", { name: "New Name" }, actor as never);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("audits user.delete", async () => {
    await ctx.controller.remove("u-9", actor as never);

    expect(mockAuditLog).toHaveBeenCalledWith({
      action: ManagementAuditAction.UserDelete,
      actor: expectedActor,
      targetType: "user",
      targetId: "u-9",
    });
  });

  it("audits user.password_reset without the generated password", async () => {
    await ctx.controller.resetPassword("u-9", actor as never);

    expect(mockAuditLog).toHaveBeenCalledWith({
      action: ManagementAuditAction.UserPasswordReset,
      actor: expectedActor,
      targetType: "user",
      targetId: "u-9",
    });
    expect(JSON.stringify(mockAuditLog.mock.calls)).not.toContain("hunter2hunter2");
  });

  it("does not audit when the service rejects the mutation", async () => {
    ctx.users.remove.mockRejectedValueOnce(new Error("cannot delete last admin"));
    await expect(ctx.controller.remove("u-9", actor as never)).rejects.toThrow();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
