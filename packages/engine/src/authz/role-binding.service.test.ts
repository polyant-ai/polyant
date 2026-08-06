// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for RoleBindingService — the org-scope role assignment / removal
 * choke-point. Covers:
 *   - assignMemberRole: writes membership and an org binding atomically.
 *   - removeMember: deletes membership and all organization bindings.
 *   - Owner-last guard: removing/replacing the only remaining Owner is blocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
const {
  mockGetSystemRoleByKey,
  mockCountOwnerBindings,
  mockUpsertOrganizationMemberRole,
  mockDeleteOrganizationMember,
  mockGetOrgScopeRoleKey,
  mockWithOrganizationMemberLock,
} = vi.hoisted(() => ({
  mockGetSystemRoleByKey: vi.fn(),
  mockCountOwnerBindings: vi.fn(),
  mockUpsertOrganizationMemberRole: vi.fn(),
  mockDeleteOrganizationMember: vi.fn(),
  mockGetOrgScopeRoleKey: vi.fn(),
  mockWithOrganizationMemberLock: vi.fn(),
}));

vi.mock("../organizations/members.store.js", () => ({
  getSystemRoleByKey: mockGetSystemRoleByKey,
  countOwnerBindings: mockCountOwnerBindings,
  upsertOrganizationMemberRole: mockUpsertOrganizationMemberRole,
  deleteOrganizationMember: mockDeleteOrganizationMember,
  getOrgScopeRoleKey: mockGetOrgScopeRoleKey,
  withOrganizationMemberLock: mockWithOrganizationMemberLock,
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { RoleBindingService } from "./role-binding.service.js";

const ORG = "org-1";

function makeService() {
  const authz = { invalidateBindingCache: vi.fn() };
  const service = new RoleBindingService(authz as never);
  return { service, authz };
}

describe("RoleBindingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSystemRoleByKey.mockResolvedValue({ id: "role-owner" });
    mockGetOrgScopeRoleKey.mockResolvedValue("member");
    mockCountOwnerBindings.mockResolvedValue(2);
    mockWithOrganizationMemberLock.mockImplementation(async (_organizationId, mutation) =>
      mutation({}),
    );
  });

  describe("assignMemberRole", () => {
    it("rejects an unknown role key", async () => {
      const { service } = makeService();
      await expect(
        service.assignMemberRole({ organizationId: ORG, userId: "u1", roleKey: "wizard" as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockUpsertOrganizationMemberRole).not.toHaveBeenCalled();
    });

    it("rejects a role that is not seeded in the catalog", async () => {
      mockGetSystemRoleByKey.mockResolvedValue(null);
      const { service } = makeService();
      await expect(
        service.assignMemberRole({ organizationId: ORG, userId: "u1", roleKey: "member" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("upserts the binding and invalidates the cache synchronously", async () => {
      const { service, authz } = makeService();
      await service.assignMemberRole({ organizationId: ORG, userId: "u1", roleKey: "member", actorId: "actor-1" });
      expect(mockUpsertOrganizationMemberRole).toHaveBeenCalledWith(
        {
          organizationId: ORG,
          userId: "u1",
          roleId: "role-owner",
          actorId: "actor-1",
        },
        {},
      );
      expect(authz.invalidateBindingCache).toHaveBeenCalledWith("u1", ORG);
    });

    it("holds the organization lock while hierarchy checks and the write run", async () => {
      const order: string[] = [];
      mockWithOrganizationMemberLock.mockImplementation(async (_organizationId, mutation) => {
        order.push("lock");
        return mutation({});
      });
      mockGetSystemRoleByKey.mockImplementation(async () => {
        order.push("role");
        return { id: "role-member" };
      });
      mockGetOrgScopeRoleKey.mockImplementation(async () => {
        order.push("hierarchy");
        return "owner";
      });
      mockUpsertOrganizationMemberRole.mockImplementation(async () => {
        order.push("write");
      });
      const { service } = makeService();

      await service.assignMemberRole({
        organizationId: ORG,
        userId: "target",
        roleKey: "owner",
        actorId: "actor",
      });

      expect(mockWithOrganizationMemberLock).toHaveBeenCalledWith(ORG, expect.any(Function));
      expect(order).toEqual(["lock", "role", "hierarchy", "hierarchy", "write"]);
      expect(mockUpsertOrganizationMemberRole).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG }),
        {},
      );
    });

    it("blocks demoting the last Owner to a non-Owner role", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(1);
      const { service, authz } = makeService();
      await expect(
        service.assignMemberRole({ organizationId: ORG, userId: "u1", roleKey: "member" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockUpsertOrganizationMemberRole).not.toHaveBeenCalled();
      expect(authz.invalidateBindingCache).not.toHaveBeenCalled();
    });

    it("allows demoting an Owner when another Owner remains", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(2);
      const { service } = makeService();
      await service.assignMemberRole({ organizationId: ORG, userId: "u1", roleKey: "member" });
      expect(mockUpsertOrganizationMemberRole).toHaveBeenCalled();
    });

    it("allows promoting a member to Owner regardless of Owner count", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("member");
      mockCountOwnerBindings.mockResolvedValue(1);
      const { service } = makeService();
      await service.assignMemberRole({ organizationId: ORG, userId: "u1", roleKey: "owner" });
      expect(mockUpsertOrganizationMemberRole).toHaveBeenCalled();
    });
  });

  describe("role hierarchy (escalation guard)", () => {
    // Resolve each user's current role by id so actor and target can differ.
    function rolesByUser(map: Record<string, string | null>) {
      mockGetOrgScopeRoleKey.mockImplementation(async (_org: string, uid: string) =>
        uid in map ? map[uid] : null,
      );
    }

    it("blocks an admin self-promoting to owner", async () => {
      rolesByUser({ actor: "admin", actor2: "admin" });
      const { service } = makeService();
      await expect(
        service.assignMemberRole({
          organizationId: ORG,
          userId: "actor", // promoting self
          roleKey: "owner",
          actorId: "actor",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockUpsertOrganizationMemberRole).not.toHaveBeenCalled();
    });

    it("lets an admin assign member/viewer to a lower-ranked user", async () => {
      rolesByUser({ actor: "admin", target: "viewer" });
      const { service } = makeService();
      await service.assignMemberRole({
        organizationId: ORG,
        userId: "target",
        roleKey: "member",
        actorId: "actor",
      });
      expect(mockUpsertOrganizationMemberRole).toHaveBeenCalled();
    });

    it("lets an owner assign owner (owner-to-owner)", async () => {
      rolesByUser({ actor: "owner", target: "member" });
      const { service } = makeService();
      await service.assignMemberRole({
        organizationId: ORG,
        userId: "target",
        roleKey: "owner",
        actorId: "actor",
      });
      expect(mockUpsertOrganizationMemberRole).toHaveBeenCalled();
    });

    it("blocks an admin from demoting an owner", async () => {
      rolesByUser({ actor: "admin", target: "owner" });
      const { service } = makeService();
      await expect(
        service.assignMemberRole({
          organizationId: ORG,
          userId: "target",
          roleKey: "member",
          actorId: "actor",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockUpsertOrganizationMemberRole).not.toHaveBeenCalled();
    });

    it("blocks an admin from removing an owner", async () => {
      rolesByUser({ actor: "admin", target: "owner" });
      const { service } = makeService();
      await expect(
        service.removeMember({ organizationId: ORG, userId: "target", actorId: "actor" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockDeleteOrganizationMember).not.toHaveBeenCalled();
    });
  });

  describe("removeMember", () => {
    it("removes membership and every organization binding, then invalidates the cache", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("member");
      mockDeleteOrganizationMember.mockResolvedValue(undefined);
      const { service, authz } = makeService();
      await service.removeMember({ organizationId: ORG, userId: "u1" });
      expect(mockDeleteOrganizationMember).toHaveBeenCalledWith(ORG, "u1", {});
      expect(authz.invalidateBindingCache).toHaveBeenCalledWith("u1", ORG);
    });

    it("holds the organization lock while owner-last validation and deletion run", async () => {
      const order: string[] = [];
      mockWithOrganizationMemberLock.mockImplementation(async (_organizationId, mutation) => {
        order.push("lock");
        return mutation({});
      });
      mockGetOrgScopeRoleKey.mockImplementation(async () => {
        order.push("owner check");
        return "member";
      });
      mockDeleteOrganizationMember.mockImplementation(async () => {
        order.push("delete");
      });
      const { service } = makeService();

      await service.removeMember({ organizationId: ORG, userId: "u1", actorId: "actor" });

      expect(mockWithOrganizationMemberLock).toHaveBeenCalledWith(ORG, expect.any(Function));
      expect(order).toEqual([
        "lock",
        "owner check",
        "owner check",
        "owner check",
        "delete",
      ]);
      expect(mockDeleteOrganizationMember).toHaveBeenCalledWith(ORG, "u1", {});
    });

    it("blocks removing the last Owner binding", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(1);
      const { service, authz } = makeService();
      await expect(
        service.removeMember({ organizationId: ORG, userId: "u1" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockDeleteOrganizationMember).not.toHaveBeenCalled();
      expect(authz.invalidateBindingCache).not.toHaveBeenCalled();
    });

    it("removes an Owner binding when another Owner remains", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(2);
      mockDeleteOrganizationMember.mockResolvedValue(undefined);
      const { service } = makeService();
      await service.removeMember({ organizationId: ORG, userId: "u1" });
      expect(mockDeleteOrganizationMember).toHaveBeenCalled();
    });
  });
});
