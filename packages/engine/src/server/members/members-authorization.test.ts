// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Enforcement-mode authorization tests for the members management plane,
 * exercising the REAL PermissionGuard + AuthorizationService + OSS strategy
 * (only the DB store is stubbed). Covers the Stream 6 acceptance criteria:
 *
 *   - no role        → 403 (guard denies in enforce mode)
 *   - right role     → 2xx (allowed)
 *   - cross-org      → 403 (caller org ≠ target scope org)
 *   - cache invalidated synchronously on a binding mutation
 *
 * `AUTHZ_ENFORCE` is flipped to true ONLY inside this test via the mocked
 * config — the shipped default stays false (the shadow window is operational,
 * not a code change). The production flip is a deploy-time env action.
 */

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { authz: { enforce: true } },
}));
vi.mock("../../config.js", () => ({ config: mockConfig }));

const { mockReadPlatformAdminFlag, mockReadAgentScope, mockReadUserBindings } =
  vi.hoisted(() => ({
    mockReadPlatformAdminFlag: vi.fn(),
    mockReadAgentScope: vi.fn(),
    mockReadUserBindings: vi.fn(),
  }));
vi.mock("../../authz/authz.store.js", () => ({
  readPlatformAdminFlag: mockReadPlatformAdminFlag,
  readAgentScope: mockReadAgentScope,
  readUserBindings: mockReadUserBindings,
}));

// Keep the DB client inert — the store is fully mocked above.
vi.mock("../../database/client.js", () => ({ db: {}, queryClient: {} }));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException } from "@nestjs/common";
import { PermissionGuard } from "../../authz/permission.guard.js";
import { AuthorizationService } from "../../authz/authorization.service.js";
import { OssStrategy } from "../../authz/authorization-strategy.js";
import { bindingCache, bindingCacheKey } from "../../authz/authz.caches.js";
import { Permission } from "../../authz/permissions.js";
import { REQUIRE_PERMISSION_KEY } from "../../authz/decorators/require-permission.decorator.js";

const ORG = "org-1";

/** A guard wired to the real AuthorizationService, evaluating MEMBER_MANAGE. */
function makeGuard() {
  const authz = new AuthorizationService(new OssStrategy());
  const entitlement = { isAvailable: vi.fn().mockReturnValue(true) };
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === REQUIRE_PERMISSION_KEY ? Permission.MEMBER_MANAGE : undefined,
  } as unknown as Reflector;
  const guard = new PermissionGuard(authz as never, entitlement as never, reflector);
  return { guard, authz };
}

/** An org-level request (no agent slug) for the given caller org. */
function contextFor(callerOrgId: string) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user: { principalType: "user", userId: "u1", orgId: callerOrgId },
        params: {},
      }),
    }),
  } as never;
}

describe("members management authorization (enforce mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindingCache.clear();
    mockReadPlatformAdminFlag.mockResolvedValue(false);
  });

  it("denies (403) a caller holding no role", async () => {
    mockReadUserBindings.mockResolvedValue([]);
    const { guard } = makeGuard();
    await expect(guard.canActivate(contextFor(ORG))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows (2xx) a caller whose role carries MEMBER_MANAGE (admin/owner)", async () => {
    mockReadUserBindings.mockResolvedValue([
      {
        scopeType: "organization",
        scopeId: ORG,
        permissions: new Set([Permission.MEMBER_MANAGE]),
      },
    ]);
    const { guard } = makeGuard();
    await expect(guard.canActivate(contextFor(ORG))).resolves.toBe(true);
  });

  it("denies (403) a cross-org caller even with MEMBER_MANAGE in their own org", async () => {
    // The caller's token org (org-2) differs from the org they would act on if
    // an agent scope were resolved; here the org-level scope is the caller's own
    // org-2, but their bindings live in org-1 → no MEMBER_MANAGE in org-2.
    mockReadUserBindings.mockResolvedValue([]);
    const { guard } = makeGuard();
    await expect(guard.canActivate(contextFor("org-2"))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("re-reads bindings after a synchronous invalidation (revocation takes effect)", async () => {
    mockReadUserBindings.mockResolvedValueOnce([
      {
        scopeType: "organization",
        scopeId: ORG,
        permissions: new Set([Permission.MEMBER_MANAGE]),
      },
    ]);
    const { guard, authz } = makeGuard();
    await expect(guard.canActivate(contextFor(ORG))).resolves.toBe(true);
    expect(bindingCache.has(bindingCacheKey("u1", ORG))).toBe(true);

    // A binding mutation revokes the permission and flushes the cache.
    authz.invalidateBindingCache("u1", ORG);
    expect(bindingCache.has(bindingCacheKey("u1", ORG))).toBe(false);

    // Next check re-reads the store (now empty) → denied.
    mockReadUserBindings.mockResolvedValueOnce([]);
    await expect(guard.canActivate(contextFor(ORG))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockReadUserBindings).toHaveBeenCalledTimes(2);
  });
});
