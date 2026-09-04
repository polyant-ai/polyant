// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for MembersService — the management-plane façade for
 * /api/organizations/:orgSlug/members. Covers org-slug resolution, the
 * cross-org isolation guard (caller org must match the addressed org), and
 * delegation of the binding mutations to RoleBindingService.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
const { mockResolveOrgIdBySlug, mockListOrganizationMembers } =
  vi.hoisted(() => ({
    mockResolveOrgIdBySlug: vi.fn(),
    mockListOrganizationMembers: vi.fn(),
  }));

vi.mock("../../organizations/members.store.js", () => ({
  resolveOrgIdBySlug: mockResolveOrgIdBySlug,
  listOrganizationMembers: mockListOrganizationMembers,
}));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { MembersService } from "./members.service.js";

const ORG_SLUG = "default";
const ORG_ID = "org-1";

function makeService({ isPlatformAdmin = false } = {}) {
  const bindings = {
    assignMemberRole: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
  };
  const authz = {
    isPlatformAdmin: vi.fn().mockResolvedValue(isPlatformAdmin),
  };
  const service = new MembersService(bindings as never, authz as never);
  return { service, bindings, authz };
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

  /**
   * The bootstrap path, and the reason the platform-admin exemption exists.
   *
   * Sign-in provisions nobody, so adding a member is the ONLY way into an
   * organization. Platform admins sit above every org and hold no membership, so
   * they carry no `orgId` — without this a fresh deployment's only privileged
   * account could not add the first member, and nothing else could either.
   */
  it("allows a platform admin with no org claim to manage any organization", async () => {
    const { service, authz } = makeService({ isPlatformAdmin: true });

    await expect(service.list(ORG_SLUG, caller(undefined))).resolves.toHaveLength(1);
    expect(authz.isPlatformAdmin).toHaveBeenCalledWith("actor-1");
  });

  it("lets a platform admin add the first member of an organization", async () => {
    const { service, bindings } = makeService({ isPlatformAdmin: true });

    await service.assign(ORG_SLUG, "u2", "admin", caller(undefined));

    expect(bindings.assignMemberRole).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, userId: "u2", roleKey: "admin" }),
    );
  });

  // The exemption is for platform admins ONLY — an ordinary org-less caller is
  // still refused, which is what keeps this the cross-org choke point.
  it("still refuses an org-less caller who is not a platform admin", async () => {
    const { service, bindings } = makeService({ isPlatformAdmin: false });

    await expect(
      service.assign(ORG_SLUG, "u2", "member", caller(undefined)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(bindings.assignMemberRole).not.toHaveBeenCalled();
  });

  it("lists members of the caller's own org", async () => {
    const { service } = makeService();
    const members = await service.list(ORG_SLUG, caller(ORG_ID));
    expect(members).toEqual([
      { userId: "u1", email: "a@x.io", name: "A", roleKey: "owner" },
    ]);
    expect(mockListOrganizationMembers).toHaveBeenCalledWith(ORG_ID);
  });

  it("delegates atomic member-role assignment with the resolved org id", async () => {
    const { service, bindings } = makeService();
    await service.assign(ORG_SLUG, "u2", "member", caller(ORG_ID));
    expect(bindings.assignMemberRole).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "u2",
      roleKey: "member",
      actorId: "actor-1",
    });
  });

  it("delegates member removal with the resolved org id", async () => {
    const { service, bindings } = makeService();
    await service.remove(ORG_SLUG, "u2", caller(ORG_ID));
    expect(bindings.removeMember).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: "u2",
      actorId: "actor-1",
    });
  });

  it("blocks a cross-org assign before touching the binding service", async () => {
    const { service, bindings } = makeService();
    await expect(
      service.assign(ORG_SLUG, "u2", "member", caller("org-other")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(bindings.assignMemberRole).not.toHaveBeenCalled();
  });
});
