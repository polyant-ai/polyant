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

function makeContext(meta: MetaMap, request: Record<string, unknown>) {
  const reflector = {
    getAllAndOverride: (key: string) => (meta as Record<string, unknown>)[key],
  } as unknown as Reflector;
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
  return { reflector, context };
}

function makeAuthz(overrides: Partial<{
  isPlatformAdmin: boolean;
  can: boolean;
  scope: AgentScope | null;
  featureAvailable: boolean;
}> = {}) {
  return {
    authz: {
      isPlatformAdmin: vi.fn().mockResolvedValue(overrides.isPlatformAdmin ?? false),
      can: vi.fn().mockResolvedValue(overrides.can ?? false),
      resolveAgentScope: vi
        .fn()
        .mockResolvedValue(overrides.scope === undefined ? SCOPE : overrides.scope),
    },
    entitlement: {
      isAvailable: vi.fn().mockReturnValue(overrides.featureAvailable ?? false),
    },
  };
}

function guardFor(deps: ReturnType<typeof makeAuthz>): PermissionGuard {
  // Reflector is overwritten per-test with a metadata-returning stub.
  return new PermissionGuard(
    deps.authz as never,
    deps.entitlement as never,
    new Reflector(),
  );
}

describe("PermissionGuard", () => {
  beforeEach(() => {
    mockConfig.authz.enforce = false;
    vi.clearAllMocks();
  });

  it("short-circuits @Public() routes", async () => {
    const deps = makeAuthz();
    const guard = guardFor(deps);
    const { reflector, context } = makeContext({ [IS_PUBLIC_KEY]: true }, {});
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(deps.authz.can).not.toHaveBeenCalled();
  });

  it("allows an undeclared route in shadow mode (logs, no deny)", async () => {
    const deps = makeAuthz();
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      {},
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: {} },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies an undeclared route once enforcement is on (fail-closed)", async () => {
    mockConfig.authz.enforce = true;
    const deps = makeAuthz();
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      {},
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: {} },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies a @RequiresFeature route when the license is missing (even shadow)", async () => {
    const deps = makeAuthz({ featureAvailable: false });
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRES_FEATURE_KEY]: "custom-roles", [REQUIRE_PERMISSION_KEY]: Permission.ORG_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.authz.can).not.toHaveBeenCalled();
  });

  it("allows a @RequiresFeature route when the license is present", async () => {
    const deps = makeAuthz({ featureAvailable: true, can: true });
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRES_FEATURE_KEY]: "custom-roles", [REQUIRE_PERMISSION_KEY]: Permission.ORG_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("bypasses permission checks for a platform admin (superadmin)", async () => {
    const deps = makeAuthz({ isPlatformAdmin: true });
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(deps.authz.can).not.toHaveBeenCalled();
  });

  it("allows a ServicePrincipal (instance API key) addressing its own agent", async () => {
    const deps = makeAuthz();
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      { user: { kind: "instance", instanceSlug: "agent-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies a ServicePrincipal addressing a DIFFERENT agent in enforce mode", async () => {
    mockConfig.authz.enforce = true;
    const deps = makeAuthz();
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      { user: { kind: "instance", instanceSlug: "agent-1" }, params: { slug: "agent-2" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("grants a declared permission when can() is true (enforce)", async () => {
    mockConfig.authz.enforce = true;
    const deps = makeAuthz({ can: true });
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(deps.authz.can).toHaveBeenCalledWith("u1", SCOPE, Permission.AGENT_WRITE);
  });

  it("denies a declared permission when can() is false (enforce)", async () => {
    mockConfig.authz.enforce = true;
    const deps = makeAuthz({ can: false });
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never throws on a denied permission in shadow mode", async () => {
    mockConfig.authz.enforce = false;
    const deps = makeAuthz({ can: false });
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies on a cross-org scope mismatch in enforce mode", async () => {
    mockConfig.authz.enforce = true;
    // Agent resolves to org-2 but the caller's token says org-1.
    const deps = makeAuthz({
      can: true,
      scope: { agentId: "agent-1", workspaceId: "ws-9", organizationId: "org-2" },
    });
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: { slug: "agent-1" } },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.authz.can).not.toHaveBeenCalled();
  });

  it("denies when the route declares a permission but no agent slug is present (enforce)", async () => {
    mockConfig.authz.enforce = true;
    const deps = makeAuthz();
    const guard = guardFor(deps);
    const { reflector, context } = makeContext(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      { user: { principalType: "user", userId: "u1", orgId: "org-1" }, params: {} },
    );
    (guard as unknown as { reflector: Reflector }).reflector = reflector;
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
