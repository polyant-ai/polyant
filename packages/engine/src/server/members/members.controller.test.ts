// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for MembersController: it is a pure HTTP bridge, so the tests
 * assert (1) every handler declares the MEMBER_MANAGE permission and the class
 * carries a throttle window (the guardrail + rate-limit acceptance criteria),
 * and (2) each handler delegates to MembersService with the path params and the
 * current user.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockAuditLog } = vi.hoisted(() => ({ mockAuditLog: vi.fn() }));

vi.mock("../../management-audit/management-audit-logger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../management-audit/management-audit-logger.js")>();
  return { ...actual, createManagementAuditLogger: () => ({ log: mockAuditLog }) };
});

import { REQUIRE_PERMISSION_KEY } from "../../authz/decorators/require-permission.decorator.js";
import { Permission } from "../../authz/permissions.js";
import { MembersController } from "./members.controller.js";
import { ManagementAuditAction } from "../../management-audit/management-audit-logger.js";

const caller = { userId: "actor-1", orgId: "org-1", email: "admin@example.com" };

function makeController() {
  const members = {
    list: vi.fn().mockResolvedValue([{ userId: "u1" }]),
    assign: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new MembersController(members as never);
  return { controller, members };
}

function permissionOf(handler: string): unknown {
  const proto = MembersController.prototype as unknown as Record<string, unknown>;
  return Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto[handler] as object);
}

describe("MembersController", () => {
  let ctx: ReturnType<typeof makeController>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeController();
  });

  it("requires MEMBER_MANAGE on every handler", () => {
    for (const handler of ["list", "assign", "remove"]) {
      expect(permissionOf(handler)).toBe(Permission.MEMBER_MANAGE);
    }
  });

  it("declares a throttle window on the controller (rate-limit)", () => {
    // @Throttle stamps a `THROTTLER:` prefixed metadata key on the class.
    const throttlerKey = Reflect.getMetadataKeys(MembersController).find(
      (k) => typeof k === "string" && k.startsWith("THROTTLER"),
    );
    expect(throttlerKey).toBeDefined();
  });

  it("list delegates to the service with the org slug and caller", async () => {
    const result = await ctx.controller.list("default", caller as never);
    expect(ctx.members.list).toHaveBeenCalledWith("default", caller);
    expect(result).toEqual({ members: [{ userId: "u1" }] });
  });

  it("assign delegates with slug, target user, role and caller", async () => {
    await ctx.controller.assign("default", "u2", { roleKey: "member" }, caller as never);
    expect(ctx.members.assign).toHaveBeenCalledWith("default", "u2", "member", caller);
  });

  it("remove delegates with slug, target user and caller", async () => {
    await ctx.controller.remove("default", "u2", caller as never);
    expect(ctx.members.remove).toHaveBeenCalledWith("default", "u2", caller);
  });

  it("audits the role grant with the granted role key", async () => {
    await ctx.controller.assign("default", "u2", { roleKey: "owner" }, caller as never);

    expect(mockAuditLog).toHaveBeenCalledWith({
      action: ManagementAuditAction.MemberRoleAssign,
      actor: { userId: "actor-1", email: "admin@example.com" },
      targetType: "member",
      targetId: "u2",
      metadata: { orgSlug: "default", roleKey: "owner" },
    });
  });

  it("does not audit a rejected grant (missing roleKey)", async () => {
    await expect(
      ctx.controller.assign("default", "u2", {}, caller as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("audits the member revoke", async () => {
    await ctx.controller.remove("default", "u2", caller as never);

    expect(mockAuditLog).toHaveBeenCalledWith({
      action: ManagementAuditAction.MemberRemove,
      actor: { userId: "actor-1", email: "admin@example.com" },
      targetType: "member",
      targetId: "u2",
      metadata: { orgSlug: "default" },
    });
  });
});
