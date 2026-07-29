// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for TenantService — the /api/me tenancy resolver. Covers a
 * resolved organization with its workspaces, an orgId that no longer exists,
 * and the no-orgId fallback to the default organization (gateway-forwarded
 * identities and pre-RBAC tokens), which must never throw.
 */

const {
  mockFindOrganizationById,
  mockFindDefaultOrganization,
  mockListWorkspacesByOrganization,
} = vi.hoisted(() => ({
  mockFindOrganizationById: vi.fn(),
  mockFindDefaultOrganization: vi.fn(),
  mockListWorkspacesByOrganization: vi.fn(),
}));

vi.mock("./organizations.store.js", () => ({
  findOrganizationById: mockFindOrganizationById,
  findDefaultOrganization: mockFindDefaultOrganization,
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

  // A gateway-forwarded identity (AUTH_MODE=alb-oidc) never carries an orgId,
  // and no re-login can add one — so the panel must resolve a tenancy anyway
  // instead of showing a "sign in again" prompt that cannot help.
  it("falls back to the default organization when the caller carries no orgId", async () => {
    mockFindDefaultOrganization.mockResolvedValue({
      id: ORG_ID,
      slug: "default",
      name: "Default",
    });
    mockListWorkspacesByOrganization.mockResolvedValue([
      { slug: "general", name: "General", isDefault: true },
    ]);

    const context = await service.getContextFor(makeUser({ orgId: undefined }));

    expect(context.organization).toEqual({ slug: "default", name: "Default" });
    expect(context.workspaces).toEqual([
      { slug: "general", name: "General", isDefault: true },
    ]);
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
    expect(mockListWorkspacesByOrganization).toHaveBeenCalledWith(ORG_ID);
  });

  it("returns organization: null when no orgId resolves and no default org is seeded", async () => {
    mockFindDefaultOrganization.mockResolvedValue(null);

    const context = await service.getContextFor(makeUser({ orgId: undefined }));

    expect(context.organization).toBeNull();
    expect(context.workspaces).toEqual([]);
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
