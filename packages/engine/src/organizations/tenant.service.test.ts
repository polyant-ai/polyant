// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for TenantService — the /api/me tenancy resolver. Covers the
 * legacy-token path (no orgId → organization: null, never a throw), a resolved
 * organization with its workspaces, and an orgId that no longer exists.
 */

const { mockFindOrganizationById, mockListWorkspacesByOrganization } = vi.hoisted(() => ({
  mockFindOrganizationById: vi.fn(),
  mockListWorkspacesByOrganization: vi.fn(),
}));

vi.mock("./organizations.store.js", () => ({
  findOrganizationById: mockFindOrganizationById,
  listWorkspacesByOrganization: mockListWorkspacesByOrganization,
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
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
  });

  it("returns organization: null for a legacy token carrying no orgId", async () => {
    const context = await service.getContextFor(makeUser({ orgId: undefined }));

    expect(context.organization).toBeNull();
    expect(context.workspaces).toEqual([]);
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
  });

  it("returns organization: null when the orgId no longer resolves", async () => {
    mockFindOrganizationById.mockResolvedValue(null);

    const context = await service.getContextFor(makeUser());

    expect(context.organization).toBeNull();
    expect(context.workspaces).toEqual([]);
    expect(mockListWorkspacesByOrganization).not.toHaveBeenCalled();
  });
});
