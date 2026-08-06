// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for PermissionGuard covering the §6.3 decision table:
 *  - @Public() short-circuit
 *  - undeclared route = deny
 *  - @RequiresFeature missing license = deny
 *  - platform-admin DB bypass
 *  - ServicePrincipal (instance API key) branch
 *  - ManagementKeyPrincipal (org API key): permission set AND same-org target
 *  - scope resolution + cross-org mismatch deny
 *  - granted / denied permission
 *
 * There is no shadow mode and no `AUTHZ_ENFORCE`, so no test here toggles one.
 * `config` is mocked as an EMPTY object deliberately: if the guard ever grows a
 * config read again — an enforcement switch by another name — these tests fail
 * on a property access rather than quietly honouring it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("../config.js", () => ({ config: {} }));

// The guard imports AuthorizationService → authz.store → database/client, which
// connects to Postgres at module load. Stub the client so the import is inert
// (the AuthorizationService is fully mocked at the constructor boundary anyway).
vi.mock("../database/client.js", () => ({ db: {}, queryClient: {} }));

import { Reflector } from "@nestjs/core";
import { ForbiddenException } from "@nestjs/common";
import { PermissionGuard } from "./permission.guard.js";
import { Permission } from "./permissions.js";
import { REQUIRE_PERMISSION_KEY } from "./decorators/require-permission.decorator.js";
import { REQUIRES_FEATURE_KEY } from "./decorators/requires-feature.decorator.js";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator.js";
import { AUTHENTICATED_ONLY_KEY } from "./decorators/authenticated-only.decorator.js";
import { REQUIRED_ROLES_KEY } from "../auth/decorators/require-role.decorator.js";
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
  [AUTHENTICATED_ONLY_KEY]?: boolean;
  [REQUIRED_ROLES_KEY]?: string[];
}

interface Overrides {
  isPlatformAdmin?: boolean;
  can?: boolean;
  scope?: AgentScope | null;
  addressedWorkspaceId?: string | null;
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
    resolveWorkspaceId: vi
      .fn()
      .mockResolvedValue(
        overrides.addressedWorkspaceId === undefined
          ? SCOPE.workspaceId
          : overrides.addressedWorkspaceId,
      ),
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
    vi.clearAllMocks();
  });

  it("short-circuits @Public() routes", async () => {
    const { guard, context, authz } = setup({ [IS_PUBLIC_KEY]: true }, {});
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("denies an undeclared route (fail-closed, unconditionally)", async () => {
    const { guard, context } = setup({}, userReq({}));
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies a @RequiresFeature route when the license is missing", async () => {
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

  it("bypasses permission checks for a platform admin", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { isPlatformAdmin: true },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("denies a platform admin that addresses an agent through a different workspace", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      {
        ...userReq({ slug: "agent-1" }),
        headers: { "x-workspace-slug": "other-workspace" },
      },
      { isPlatformAdmin: true, addressedWorkspaceId: "ws-2" },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.resolveWorkspaceId).toHaveBeenCalledWith("org-1", "other-workspace");
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("allows a ServicePrincipal (instance API key) addressing its own agent", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      { user: { kind: "instance", instanceSlug: "agent-1" }, params: { slug: "agent-1" } },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("denies an instance API key that addresses its own agent through a different workspace", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      {
        user: { kind: "instance", instanceSlug: "agent-1" },
        params: { slug: "agent-1" },
        headers: { "x-workspace-slug": "other-workspace" },
      },
      { addressedWorkspaceId: "ws-2" },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.resolveWorkspaceId).toHaveBeenCalledWith("org-1", "other-workspace");
  });

  it("denies a ServicePrincipal addressing a DIFFERENT agent", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      { user: { kind: "instance", instanceSlug: "agent-1" }, params: { slug: "agent-2" } },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a management-key ServicePrincipal whose permission set contains the required permission", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      {
        user: {
          principalType: "service",
          orgId: "org-1",
          permissions: new Set([Permission.AGENT_READ]),
        },
        params: { slug: "agent-1" },
      },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    // The org-scoped service principal is decided purely from its own set —
    // it never consults the user-scoped authorization service.
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("denies a management key that addresses an agent through a different workspace", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      {
        user: {
          principalType: "service",
          orgId: "org-1",
          permissions: new Set([Permission.AGENT_READ]),
        },
        params: { slug: "agent-1" },
        headers: { "x-workspace-slug": "other-workspace" },
      },
      { addressedWorkspaceId: "ws-2" },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.resolveWorkspaceId).toHaveBeenCalledWith("org-1", "other-workspace");
  });

  it("denies a management-key ServicePrincipal lacking the required permission", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_DELETE },
      {
        user: {
          principalType: "service",
          orgId: "org-1",
          permissions: new Set([Permission.AGENT_READ]),
        },
        params: { slug: "agent-1" },
      },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // A management key grants what was issued, but only inside its OWN org. The
  // four tests below are the regression net for the cross-tenant hole where the
  // key branch decided on the permission set alone and never looked at the
  // addressed agent — a key of org A could read and overwrite the secrets,
  // prompts and channels of every other tenant.
  it("should_deny_management_key_when_the_addressed_agent_belongs_to_another_org", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.SECRET_WRITE },
      {
        user: {
          principalType: "service",
          orgId: "org-1",
          permissions: new Set([Permission.SECRET_WRITE]),
        },
        params: { slug: "agent-of-org-2" },
      },
      { scope: { agentId: "agent-2", workspaceId: "ws-2", organizationId: "org-2" } },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("should_deny_management_key_when_the_addressed_agent_does_not_exist", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      {
        user: {
          principalType: "service",
          orgId: "org-1",
          permissions: new Set([Permission.AGENT_READ]),
        },
        params: { slug: "ghost" },
      },
      { scope: null },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("should_allow_management_key_on_an_org_level_route_without_resolving_an_agent", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_READ },
      {
        user: {
          principalType: "service",
          orgId: "org-1",
          permissions: new Set([Permission.AGENT_READ]),
        },
        params: {},
      },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authz.resolveAgentScope).not.toHaveBeenCalled();
  });

  it("should_deny_a_management_key_addressing_an_agent_of_another_org", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.SECRET_WRITE },
      {
        user: {
          principalType: "service",
          orgId: "org-1",
          permissions: new Set([Permission.SECRET_WRITE]),
        },
        params: { slug: "agent-of-org-2" },
      },
      { scope: { agentId: "agent-2", workspaceId: "ws-2", organizationId: "org-2" } },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // Two decorators declare authorization WITHOUT naming a permission. Treating
  // either as "undeclared" made the route 403 for everyone under enforcement —
  // including platform platform admins, whose bypass sits past this branch. That is
  // how the entire /api/users surface became unreachable in production.
  it("should_allow_an_authenticated_only_route_for_a_user_principal", async () => {
    const { guard, context } = setup(
      { [AUTHENTICATED_ONLY_KEY]: true },
      userReq({}),
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("should_deny_an_authenticated_only_route_for_a_service_principal", async () => {
    const { guard, context } = setup({ [AUTHENTICATED_ONLY_KEY]: true }, {
      user: {
        principalType: "service",
        orgId: "org-1",
        permissions: new Set([Permission.AGENT_READ]),
      },
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("should_deny_an_authenticated_only_route_for_an_instance_principal", async () => {
    const { guard, context } = setup({ [AUTHENTICATED_ONLY_KEY]: true }, {
      user: { kind: "instance", instanceSlug: "agent-1" },
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("should_deny_a_non_platform_admin_require_role_without_a_permission", async () => {
    // `@RequireRole("user")` names the role every authenticated principal
    // already has, so accepting it alone was an unscoped allow-all. It must be
    // paired with @RequirePermission to authorize anything.
    const { guard, context, authz } = setup(
      { [REQUIRED_ROLES_KEY]: ["user"] },
      userReq({}),
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("should_still_deny_a_route_with_an_empty_require_role_list", async () => {
    // An empty list is not a declaration — RoleGuard short-circuits to allow on
    // it, so treating it as declared here would leave the route wide open.
    const { guard, context } = setup({ [REQUIRED_ROLES_KEY]: [] }, userReq({}));
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("grants a declared permission when can() is true", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { can: true },
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authz.can).toHaveBeenCalledWith("u1", SCOPE, Permission.AGENT_WRITE);
  });

  it("denies a user that addresses an agent through an unknown workspace", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      {
        ...userReq({ slug: "agent-1" }),
        headers: { "x-workspace-slug": "missing-workspace" },
      },
      { can: true, addressedWorkspaceId: null },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.resolveWorkspaceId).toHaveBeenCalledWith("org-1", "missing-workspace");
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("denies a present but malformed workspace address", async () => {
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      {
        ...userReq({ slug: "agent-1" }),
        headers: { "X-Workspace-Slug": "Uppercase-Workspace" },
      },
      { can: true },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.resolveAgentScope).not.toHaveBeenCalled();
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("denies a declared permission when can() is false", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { can: false },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies on a cross-org scope mismatch", async () => {
    // Agent resolves to org-2 but the caller's token says org-1.
    const { guard, context, authz } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({ slug: "agent-1" }),
      { can: true, scope: { agentId: "agent-1", workspaceId: "ws-9", organizationId: "org-2" } },
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("denies when the route declares a permission but no agent slug is present", async () => {
    const { guard, context } = setup(
      { [REQUIRE_PERMISSION_KEY]: Permission.AGENT_WRITE },
      userReq({}),
    );
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
