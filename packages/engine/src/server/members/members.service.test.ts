// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for MembersService — the management-plane façade for
 * /api/organizations/:orgSlug/members. Covers org-slug resolution, the
 * cross-org isolation guard (caller org must match the addressed org), and
 * delegation of the binding mutations to RoleBindingService.
 */

const { mockResolveOrgIdBySlug, mockListOrganizationMembers, mockEnsureDefaultMembership } =
  vi.hoisted(() => ({
    mockResolveOrgIdBySlug: vi.fn(),
    mockListOrganizationMembers: vi.fn(),
    mockEnsureDefaultMembership: vi.fn(),
  }));

vi.mock("../../organizations/members.store.js", () => ({
  resolveOrgIdBySlug: mockResolveOrgIdBySlug,
  listOrganizationMembers: mockListOrganizationMembers,
}));

vi.mock("../../organizations/organizations.store.js", () => ({
  ensureDefaultMembership: mockEnsureDefaultMembership,
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { MembersService } from "./members.service.js";

const ORG_SLUG = "default";
const ORG_ID = "org-1";

function makeService({ isPlatformAdmin = false } = {}) {
  const bindings = {
    assignRole: vi.fn().mockResolvedValue(undefined),
    removeBinding: vi.fn().mockResolvedValue(undefined),
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

    expect(mockEnsureDefaultMembership).toHaveBeenCalledWith(ORG_ID, "u2");
    expect(bindings.assignRole).toHaveBeenCalledWith(
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
    expect(mockEnsureDefaultMembership).not.toHaveBeenCalled();
    expect(bindings.assignRole).not.toHaveBeenCalled();
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

  /**
   * BOTH rows, not just the binding. `role_bindings` is what `can()` reads for
   * permissions; `organization_memberships` is what the sign-in callback reads to
   * stamp `orgId` into the token. Writing only the binding — which is all
   * `assignRole` does — produced an added member who resolved no scope and was
   * denied everywhere, previously masked by sign-in auto-provisioning creating the
   * membership for everyone.
   */
  it("creates the membership as well as the binding, membership first", async () => {
    const order: string[] = [];
    const { service, bindings } = makeService();
    mockEnsureDefaultMembership.mockImplementation(async () => void order.push("membership"));
    bindings.assignRole.mockImplementation(async () => void order.push("binding"));

    await service.assign(ORG_SLUG, "u2", "member", caller(ORG_ID));

    expect(mockEnsureDefaultMembership).toHaveBeenCalledWith(ORG_ID, "u2");
    // Membership grants nothing on its own, so a failure between the two leaves a
    // member with an empty panel rather than a binding nobody can reach.
    expect(order).toEqual(["membership", "binding"]);
  });

  it("delegates remove to RoleBindingService with the resolved org id", async () => {
    const { service, bindings } = makeService();
    await service.remove(ORG_SLUG, "u2", caller(ORG_ID));
    expect(bindings.removeBinding).toHaveBeenCalledWith({
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
    expect(bindings.assignRole).not.toHaveBeenCalled();
  });
});
