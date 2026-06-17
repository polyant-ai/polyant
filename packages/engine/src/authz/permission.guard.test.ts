// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for PermissionGuard covering the §6.3 decision table:
 *  - @Public() short-circuit
 *  - undeclared route: shadow = allow + log, enforce = deny
 *  - @RequiresFeature missing license = deny (even in shadow)
 *  - superadmin DB bypass
 *  - ServicePrincipal (instance API key) branch
 *  - scope resolution + cross-org mismatch deny
 *  - granted / denied permission in enforce mode
 *  - shadow mode never throws on a denied permission
 */

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { authz: { enforce: false } },
}));

vi.mock("../config.js", () => ({ config: mockConfig }));

// The guard imports AuthorizationService → authz.store → database/client, which
// connects to Postgres at module load. Stub the client so the import is inert
// (the AuthorizationService is fully mocked at the constructor boundary anyway).
vi.mock("../database/client.js", () => ({ db: {}, queryClient: {} }));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException } from "@nestjs/common";
import { PermissionGuard } from "./permission.guard.js";
import { Permission } from "./permissions.js";
import { REQUIRE_PERMISSION_KEY } from "./decorators/require-permission.decorator.js";
import { REQUIRES_FEATURE_KEY } from "./decorators/requires-feature.decorator.js";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator.js";
import type { AgentScope } from "./authz.store.js";

const SCOPE: AgentScope = {
  agentId: "agent-1",
  workspaceId: "ws-1",
  organizationId: "org-1",
};

interface MetaMap {
  [REQUIRE_PERMISSION_KEY]?: string;
  [REQUIRES_FEATURE_KEY]?: string;
  [IS_PUBLIC_KEY]?: boolean;
}

interface Overrides {
  isPlatformAdmin?: boolean;
  can?: boolean;
  scope?: AgentScope | null;
  featureAvailable?: boolean;
}

/**
 * Build a guard wired to fully-stubbed dependencies plus an ExecutionContext
 * whose Reflector returns `meta`. Returns the pieces each test asserts on.
 */
function setup(meta: MetaMap, request: Record<string, unknown>, overrides: Overrides = {}) {
  const authz = {
    isPlatformAdmin: vi.fn().mockResolvedValue(overrides.isPlatformAdmin ?? false),
    can: vi.fn().mockResolvedValue(overrides.can ?? false),
    resolveAgentScope: vi
      .fn()
      .mockResolvedValue(overrides.scope === undefined ? SCOPE : overrides.scope),
  };
  const entitlement = {
    isAvailable: vi.fn().mockReturnValue(overrides.featureAvailable ?? false),
  };
  const reflector = {
    getAllAndOverride: (key: string) => (meta as Record<string, unknown>)[key],
  } as unknown as Reflector;
  const guard = new PermissionGuard(authz as never, entitlement as never, reflector);
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
  return { guard, context, authz, entitlement };
}

const userReq = (params: Record<string, string>) => ({
  user: { principalType: "user", userId: "u1", orgId: "org-1" },
  params,
});

describe("PermissionGuard", () => {
  beforeEach(() => {
    mockConfig.authz.enforce = false;
    vi.clearAllMocks();
  });

  it("short-circuits @Public() routes", async () => {
    const { guard, context, authz } = setup({ [IS_PUBLIC_KEY]: true }, {});
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("allows an undeclared route in shadow mode (logs, no deny)", async () => {
    const { guard, context } = setup({}, userReq({}));
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies an undeclared route once enforcement is on (fail-closed)", async () => {
    mockConfig.authz.enforce = true;
    const { guard, context } = setup({}, userReq({}));
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies a @RequiresFeature route when the license is missing (even shadow)", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRES_FEATURE_KEY]: "custom-roles", [REQUIRE_PERMISSION_KEY]: Permission.ORG_WRITE },
      userReq({ slug: "agent-1" }),
      { featureAvailable: false },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("allows a @RequiresFeature route when the license is present", async () => {
    const { guard, context } = setup(
      { [REQUIRES_FEATURE_KEY]: "custom-roles", [REQUIRE_PERMISSION_KEY]: Permission.ORG_WRITE },
      userReq({ slug: "agent-1" }),
      { featureAvailable: true, can: true },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("bypasses permission checks for a platform admin (superadmin)", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { isPlatformAdmin: true },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("allows a ServicePrincipal (instance API key) addressing its own agent", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      { user: { kind: "instance", instanceSlug: "agent-1" }, params: { slug: "agent-1" } },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies a ServicePrincipal addressing a DIFFERENT agent in enforce mode", async () => {
    mockConfig.authz.enforce = true;
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      { user: { kind: "instance", instanceSlug: "agent-1" }, params: { slug: "agent-2" } },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("grants a declared permission when can() is true (enforce)", async () => {
    mockConfig.authz.enforce = true;
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { can: true },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authz.can).toHaveBeenCalledWith("u1", SCOPE, Permission.AGENT_WRITE);
  });

  it("denies a declared permission when can() is false (enforce)", async () => {
    mockConfig.authz.enforce = true;
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { can: false },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never throws on a denied permission in shadow mode", async () => {
    mockConfig.authz.enforce = false;
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { can: false },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies on a cross-org scope mismatch in enforce mode", async () => {
    mockConfig.authz.enforce = true;
    // Agent resolves to org-2 but the caller's token says org-1.
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { can: true, scope: { agentId: "agent-1", workspaceId: "ws-9", organizationId: "org-2" } },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("denies when the route declares a permission but no agent slug is present (enforce)", async () => {
    mockConfig.authz.enforce = true;
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({}),
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
