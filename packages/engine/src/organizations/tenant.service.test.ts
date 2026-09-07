// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for TenantService — the /api/me tenancy resolver. Covers a
 * resolved organization with its workspaces, an orgId that no longer exists,
 * and the no-orgId fallback to the default organization (gateway-forwarded
 * identities and pre-RBAC tokens), which must never throw.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
const {
  mockFindOrganizationById,
  mockFindDefaultOrganization,
  mockIsOrganizationMember,
  mockListWorkspacesByOrganization,
} = vi.hoisted(() => ({
  mockFindOrganizationById: vi.fn(),
  mockFindDefaultOrganization: vi.fn(),
  mockIsOrganizationMember: vi.fn(),
  mockListWorkspacesByOrganization: vi.fn(),
}));

vi.mock("./organizations.store.js", () => ({
  findOrganizationById: mockFindOrganizationById,
  findDefaultOrganization: mockFindDefaultOrganization,
  isOrganizationMember: mockIsOrganizationMember,
  listWorkspacesByOrganization: mockListWorkspacesByOrganization,
}));

import { TenantService } from "./tenant.service.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: "user-1",
    email: "owner@example.test",
    principalType: "user",
    orgId: ORG_ID,
    ...overrides,
  };
}

describe("TenantService.getContextFor", () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TenantService();
    mockIsOrganizationMember.mockResolvedValue(true);
  });

  it("resolves the organization and its workspaces", async () => {
    mockFindOrganizationById.mockResolvedValue({ id: ORG_ID, slug: "default", name: "Default" });
    mockListWorkspacesByOrganization.mockResolvedValue([
      { slug: "default", name: "Default", isDefault: true },
    ]);

    const context = await service.getContextFor(makeUser({ name: "Owner" }));

    expect(context.organization).toEqual({ slug: "default", name: "Default" });
    expect(context.workspaces).toEqual([{ slug: "default", name: "Default", isDefault: true }]);
    expect(mockFindOrganizationById).toHaveBeenCalledWith(ORG_ID);
    expect(mockIsOrganizationMember).toHaveBeenCalledWith(ORG_ID, "user-1");
  });

  // A caller with no orgId holds no tenancy, and the honest answer is to say so.
  //
  // This used to fall back to the default organization, justified as
  // "unreachable under enforcement anyway". It was reachable: `GET /api/me`
  // declares `@AuthenticatedOnly()`, which short-circuits before scope
  // resolution. So the fallback handed the seed org's slug/name and all of its
  // workspace slugs to any authenticated caller holding no binding, and made the
  // panel build URLs into an org whose pages then 403 one by one.
  it("returns organization: null when the caller carries no orgId", async () => {
    mockListWorkspacesByOrganization.mockResolvedValue([
      { slug: "general", name: "General", isDefault: true },
    ]);

    const context = await service.getContextFor(makeUser({ orgId: undefined }));

    expect(context.organization).toBeNull();
    expect(context.workspaces).toEqual([]);
    // Neither lookup runs: there is no organization to resolve, and in
    // particular the default org is never consulted.
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
    expect(mockFindDefaultOrganization).not.toHaveBeenCalled();
    expect(mockIsOrganizationMember).not.toHaveBeenCalled();
    expect(mockListWorkspacesByOrganization).not.toHaveBeenCalled();
  });

  it("returns no tenant topology when an old JWT names an organization the user no longer belongs to", async () => {
    mockIsOrganizationMember.mockResolvedValue(false);

    const context = await service.getContextFor(makeUser());

    expect(context).toEqual({ organization: null, workspaces: [] });
    expect(mockIsOrganizationMember).toHaveBeenCalledWith(ORG_ID, "user-1");
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
    expect(mockListWorkspacesByOrganization).not.toHaveBeenCalled();
  });

  it("returns organization: null when the orgId no longer resolves", async () => {
    mockFindOrganizationById.mockResolvedValue(null);

    const context = await service.getContextFor(makeUser());

    expect(context.organization).toBeNull();
    expect(context.workspaces).toEqual([]);
    expect(mockListWorkspacesByOrganization).not.toHaveBeenCalled();
  });
});
