// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for MembersService — the management-plane façade for
 * /api/organizations/:orgSlug/members. Covers org-slug resolution, the
 * cross-org isolation guard (caller org must match the addressed org), and
 * delegation of the binding mutations to RoleBindingService.
 */

const { mockResolveOrgIdBySlug, mockListOrganizationMembers } = vi.hoisted(() => ({
  mockResolveOrgIdBySlug: vi.fn(),
  mockListOrganizationMembers: vi.fn(),
}));

vi.mock("../../organizations/members.store.js", () => ({
  resolveOrgIdBySlug: mockResolveOrgIdBySlug,
  listOrganizationMembers: mockListOrganizationMembers,
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { MembersService } from "./members.service.js";

const ORG_SLUG = "default";
const ORG_ID = "org-1";

function makeService() {
  const bindings = {
    assignRole: vi.fn().mockResolvedValue(undefined),
    removeBinding: vi.fn().mockResolvedValue(undefined),
  };
  const service = new MembersService(bindings as never);
  return { service, bindings };
}

const caller = (orgId?: string) => ({ userId: "actor-1", orgId });

describe("MembersService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveOrgIdBySlug.mockResolvedValue(ORG_ID);
    mockListOrganizationMembers.mockResolvedValue([
      { userId: "u1", email: "a@x.io", name: "A", roleKey: "owner" },
    ]);
  });

  it("404s when the organization slug is unknown", async () => {
    mockResolveOrgIdBySlug.mockResolvedValue(null);
    const { service } = makeService();
    await expect(service.list(ORG_SLUG, caller(ORG_ID))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("403s when the caller's org differs from the addressed org (cross-org)", async () => {
    const { service } = makeService();
    await expect(
      service.list(ORG_SLUG, caller("org-other")),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s when the caller carries no org claim", async () => {
    const { service } = makeService();
    await expect(service.list(ORG_SLUG, caller(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lists members of the caller's own org", async () => {
    const { service } = makeService();
    const members = await service.list(ORG_SLUG, caller(ORG_ID));
    expect(members).toEqual([
      { userId: "u1", email: "a@x.io", name: "A", roleKey: "owner" },
    ]);
    expect(mockListOrganizationMembers).toHaveBeenCalledWith(ORG_ID);
  });

  it("delegates assign to RoleBindingService with the resolved org id", async () => {
    const { service, bindings } = makeService();
    await service.assign(ORG_SLUG, "u2", "member", caller(ORG_ID));
    expect(bindings.assignRole).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "u2",
      roleKey: "member",
      actorId: "actor-1",
    });
  });

  it("delegates remove to RoleBindingService with the resolved org id", async () => {
    const { service, bindings } = makeService();
    await service.remove(ORG_SLUG, "u2", caller(ORG_ID));
    expect(bindings.removeBinding).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "u2",
    });
  });

  it("blocks a cross-org assign before touching the binding service", async () => {
    const { service, bindings } = makeService();
    await expect(
      service.assign(ORG_SLUG, "u2", "member", caller("org-other")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(bindings.assignRole).not.toHaveBeenCalled();
  });
});
