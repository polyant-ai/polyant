// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for RoleBindingService — the org-scope role assignment / removal
 * choke-point. Covers:
 *   - assignRole: rejects an unknown role, writes the binding, invalidates cache.
 *   - removeBinding: deletes the binding and invalidates cache.
 *   - Owner-last guard: removing/replacing the only remaining Owner is blocked.
 */

const {
  mockGetSystemRoleByKey,
  mockCountOwnerBindings,
  mockUpsertOrgScopeBinding,
  mockDeleteOrgScopeBinding,
  mockGetOrgScopeRoleKey,
} = vi.hoisted(() => ({
  mockGetSystemRoleByKey: vi.fn(),
  mockCountOwnerBindings: vi.fn(),
  mockUpsertOrgScopeBinding: vi.fn(),
  mockDeleteOrgScopeBinding: vi.fn(),
  mockGetOrgScopeRoleKey: vi.fn(),
}));

vi.mock("../organizations/members.store.js", () => ({
  getSystemRoleByKey: mockGetSystemRoleByKey,
  countOwnerBindings: mockCountOwnerBindings,
  upsertOrgScopeBinding: mockUpsertOrgScopeBinding,
  deleteOrgScopeBinding: mockDeleteOrgScopeBinding,
  getOrgScopeRoleKey: mockGetOrgScopeRoleKey,
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException, ConflictException } from "@nestjs/common";
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
  });

  describe("assignRole", () => {
    it("rejects an unknown role key", async () => {
      const { service } = makeService();
      await expect(
        service.assignRole({ organizationId: ORG, userId: "u1", roleKey: "wizard" as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockUpsertOrgScopeBinding).not.toHaveBeenCalled();
    });

    it("rejects a role that is not seeded in the catalog", async () => {
      mockGetSystemRoleByKey.mockResolvedValue(null);
      const { service } = makeService();
      await expect(
        service.assignRole({ organizationId: ORG, userId: "u1", roleKey: "member" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("upserts the binding and invalidates the cache synchronously", async () => {
      const { service, authz } = makeService();
      await service.assignRole({ organizationId: ORG, userId: "u1", roleKey: "member", actorId: "actor-1" });
      expect(mockUpsertOrgScopeBinding).toHaveBeenCalledWith({
        organizationId: ORG,
        userId: "u1",
        roleId: "role-owner",
        actorId: "actor-1",
      });
      expect(authz.invalidateBindingCache).toHaveBeenCalledWith("u1", ORG);
    });

    it("blocks demoting the last Owner to a non-Owner role", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(1);
      const { service, authz } = makeService();
      await expect(
        service.assignRole({ organizationId: ORG, userId: "u1", roleKey: "member" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockUpsertOrgScopeBinding).not.toHaveBeenCalled();
      expect(authz.invalidateBindingCache).not.toHaveBeenCalled();
    });

    it("allows demoting an Owner when another Owner remains", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(2);
      const { service } = makeService();
      await service.assignRole({ organizationId: ORG, userId: "u1", roleKey: "member" });
      expect(mockUpsertOrgScopeBinding).toHaveBeenCalled();
    });

    it("allows promoting a member to Owner regardless of Owner count", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("member");
      mockCountOwnerBindings.mockResolvedValue(1);
      const { service } = makeService();
      await service.assignRole({ organizationId: ORG, userId: "u1", roleKey: "owner" });
      expect(mockUpsertOrgScopeBinding).toHaveBeenCalled();
    });
  });

  describe("removeBinding", () => {
    it("removes a non-Owner binding and invalidates the cache", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("member");
      mockDeleteOrgScopeBinding.mockResolvedValue(true);
      const { service, authz } = makeService();
      await service.removeBinding({ organizationId: ORG, userId: "u1" });
      expect(mockDeleteOrgScopeBinding).toHaveBeenCalledWith(ORG, "u1");
      expect(authz.invalidateBindingCache).toHaveBeenCalledWith("u1", ORG);
    });

    it("blocks removing the last Owner binding", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(1);
      const { service, authz } = makeService();
      await expect(
        service.removeBinding({ organizationId: ORG, userId: "u1" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockDeleteOrgScopeBinding).not.toHaveBeenCalled();
      expect(authz.invalidateBindingCache).not.toHaveBeenCalled();
    });

    it("removes an Owner binding when another Owner remains", async () => {
      mockGetOrgScopeRoleKey.mockResolvedValue("owner");
      mockCountOwnerBindings.mockResolvedValue(2);
      mockDeleteOrgScopeBinding.mockResolvedValue(true);
      const { service } = makeService();
      await service.removeBinding({ organizationId: ORG, userId: "u1" });
      expect(mockDeleteOrgScopeBinding).toHaveBeenCalled();
    });
  });
});
