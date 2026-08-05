// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * End-to-end test of the global guard CHAIN over real HTTP.
 *
 * Every other authorization test in this repo invokes a guard directly with a
 * hand-built ExecutionContext. That leaves the composition untested: the order
 * the guards run in, whether `request.user` is populated before the guard that
 * reads it, and whether a decorator honoured by one guard is treated as a
 * declaration by the next. Those are precisely the seams that broke — a
 * `@RequireRole`-only route was authorized by RoleGuard and then 403'd by
 * PermissionGuard, and nothing in a 2000-test suite noticed.
 *
 * So this boots a real Nest application with the real AuthGuard, RoleGuard and
 * PermissionGuard registered as APP_GUARD in the real order, binds it to an
 * ephemeral port, and makes real requests. Only the leaves are stubbed: token
 * validation and the authorization store.
 */

const { mockConfig, validateSessionToken, validateManagementApiKey, findInstanceByAuthApiKey } =
  vi.hoisted(() => ({
    mockConfig: { auth: { mode: "session" } },
    validateSessionToken: vi.fn(),
    validateManagementApiKey: vi.fn(),
    findInstanceByAuthApiKey: vi.fn(),
  }));

vi.mock("../config.js", () => ({ config: mockConfig }));
vi.mock("../auth/auth-user.service.js", () => ({ validateSessionToken }));
vi.mock("../auth/management-api-keys.store.js", () => ({ validateManagementApiKey }));
vi.mock("../instances/secrets.store.js", () => ({ findInstanceByAuthApiKey }));
vi.mock("../database/client.js", () => ({ db: {}, queryClient: {} }));

import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { AuthGuard } from "../auth/auth.guard.js";
import { RoleGuard } from "../auth/role.guard.js";
import { Public } from "../auth/decorators/public.decorator.js";
import { RequireRole } from "../auth/decorators/require-role.decorator.js";
import { PermissionGuard } from "../authz/permission.guard.js";
import { AuthorizationService } from "../authz/authorization.service.js";
import { ENTITLEMENT_SERVICE } from "../authz/entitlement.service.js";
import { AuthenticatedOnly, Permission, RequirePermission } from "../authz/index.js";

const authz = {
  isPlatformAdmin: vi.fn(),
  can: vi.fn(),
  resolveAgentScope: vi.fn(),
  resolveWorkspaceId: vi.fn(),
};

/** One route per way a handler can declare (or fail to declare) authorization. */
@Controller("probe")
class ProbeController {
  @Public()
  @Get("public")
  publicRoute() {
    return { ok: "public" };
  }

  @RequirePermission(Permission.AGENT_READ)
  @Get("permission")
  permissionRoute() {
    return { ok: "permission" };
  }

  @AuthenticatedOnly()
  @Get("authenticated-only")
  authenticatedOnlyRoute() {
    return { ok: "authenticated-only" };
  }

  @RequireRole("platform_admin")
  @Get("role")
  roleRoute() {
    return { ok: "role" };
  }

  /** Agent-addressed: `:slug` is what makes the guard resolve a tenancy scope. */
  @RequirePermission(Permission.SECRET_WRITE)
  @Get("agent/:slug/secrets")
  agentRoute() {
    return { ok: "agent" };
  }

  @Get("undeclared")
  undeclaredRoute() {
    return { ok: "undeclared" };
  }
}

// Guard registration order mirrors production: AuthModule (AuthGuard, then
// RoleGuard) is imported before AuthzModule (PermissionGuard), and the module
// insertion order IS the global-guard execution order.
@Module({
  controllers: [ProbeController],
  providers: [
    Reflector,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: AuthorizationService, useValue: authz },
    { provide: ENTITLEMENT_SERVICE, useValue: { isAvailable: () => true } },
  ],
})
class GuardChainTestModule {}

let app: INestApplication;
let baseUrl: string;

const AGENT_SCOPE = { agentId: "a", workspaceId: "w", organizationId: "org-1" };
/** The probe routes carry no `:slug`, so the guard resolves an org-level scope. */
const ORG_SCOPE = { agentId: "", workspaceId: "", organizationId: "org-1" };

/** Bearer token that `validateSessionToken` is stubbed to resolve to a user. */
const SESSION = "session-token";

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const asUser = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  email: "u1@example.com",
  role: "user",
  orgId: "org-1",
  principalType: "user",
  ...over,
});

beforeAll(async () => {
  app = await NestFactory.create(GuardChainTestModule, { logger: false });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.auth.mode = "session";
  authz.isPlatformAdmin.mockResolvedValue(false);
  authz.can.mockResolvedValue(true);
  authz.resolveAgentScope.mockResolvedValue(AGENT_SCOPE);
  authz.resolveWorkspaceId.mockResolvedValue(AGENT_SCOPE.workspaceId);
  validateSessionToken.mockResolvedValue(asUser());
  validateManagementApiKey.mockResolvedValue(null);
  findInstanceByAuthApiKey.mockResolvedValue(null);
});

describe("global guard chain over HTTP", () => {
  it("should_serve_a_public_route_without_any_credential", async () => {
    const res = await get("/probe/public");
    expect(res.status).toBe(200);
    expect(validateSessionToken).not.toHaveBeenCalled();
  });

  it("should_401_a_declared_route_when_no_credential_is_presented", async () => {
    const res = await get("/probe/permission");
    expect(res.status).toBe(401);
  });

  it("should_401_before_authorizing_when_the_session_token_is_invalid", async () => {
    validateSessionToken.mockResolvedValue(null);
    const res = await get("/probe/permission", { authorization: `Bearer ${SESSION}` });
    expect(res.status).toBe(401);
    // AuthGuard rejected first: PermissionGuard never got to decide.
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("should_allow_a_permission_route_when_the_authorization_service_grants_it", async () => {
    const res = await get("/probe/permission", { authorization: `Bearer ${SESSION}` });
    expect(res.status).toBe(200);
    // The whole point of the chain: AuthGuard populated request.user BEFORE
    // PermissionGuard read it. A wrong guard order shows up here as a deny.
    expect(authz.can).toHaveBeenCalledWith("u1", ORG_SCOPE, Permission.AGENT_READ);
  });

  it("should_403_a_permission_route_when_the_authorization_service_denies_it", async () => {
    authz.can.mockResolvedValue(false);
    const res = await get("/probe/permission", { authorization: `Bearer ${SESSION}` });
    expect(res.status).toBe(403);
  });

  it("should_403_an_undeclared_route", async () => {
    const res = await get("/probe/undeclared", { authorization: `Bearer ${SESSION}` });
    expect(res.status).toBe(403);
  });

  it("should_allow_an_authenticated_only_route_for_any_signed_in_user", async () => {
    const res = await get("/probe/authenticated-only", { authorization: `Bearer ${SESSION}` });
    expect(res.status).toBe(200);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("should_deny_an_authenticated_only_route_for_a_management_key", async () => {
    validateManagementApiKey.mockResolvedValue({
      principalType: "service",
      orgId: "org-1",
      permissions: new Set([Permission.AGENT_READ]),
    });
    const res = await get("/probe/authenticated-only", { "x-polyant-key": "pk_test" });
    expect(res.status).toBe(403);
  });

  // The regression this whole file exists for: RoleGuard authorizes the route,
  // PermissionGuard must not then 403 it as "undeclared". Every /api/users
  // endpoint was dead in production for exactly this reason.
  it("should_allow_a_role_only_route_for_a_matching_role", async () => {
    validateSessionToken.mockResolvedValue(asUser({ role: "platform_admin" }));
    authz.isPlatformAdmin.mockResolvedValue(true);
    const res = await get("/probe/role", { authorization: `Bearer ${SESSION}` });
    expect(res.status).toBe(200);
  });

  it("should_403_a_role_only_platform_admin_route_when_the_jwt_role_is_stale", async () => {
    // RoleGuard is deliberately a JWT prefilter, so this gets past it. The
    // following PermissionGuard must consult the current DB-backed flag before
    // granting a platform-admin-only route.
    validateSessionToken.mockResolvedValue(asUser({ role: "platform_admin" }));
    authz.isPlatformAdmin.mockResolvedValue(false);

    const res = await get("/probe/role", { authorization: `Bearer ${SESSION}` });

    expect(res.status).toBe(403);
    expect(authz.isPlatformAdmin).toHaveBeenCalledWith("u1");
  });

  it("should_403_a_role_only_route_for_a_non_matching_role", async () => {
    validateSessionToken.mockResolvedValue(asUser({ role: "user" }));
    const res = await get("/probe/role", { authorization: `Bearer ${SESSION}` });
    expect(res.status).toBe(403);
  });

  it("should_403_a_platform_admin_when_the_workspace_address_does_not_own_the_agent", async () => {
    validateSessionToken.mockResolvedValue(asUser({ role: "platform_admin" }));
    authz.isPlatformAdmin.mockResolvedValue(true);
    authz.resolveWorkspaceId.mockResolvedValue("other-workspace-id");

    const res = await get("/probe/agent/mine/secrets", {
      authorization: `Bearer ${SESSION}`,
      "x-workspace-slug": "other-workspace",
    });

    expect(res.status).toBe(403);
    expect(authz.resolveWorkspaceId).toHaveBeenCalledWith("org-1", "other-workspace");
    expect(authz.can).not.toHaveBeenCalled();
  });

  // A management key carries its own permission set and never consults the
  // authorization service — which is why it also has to be pinned to its own
  // organization here, or the key becomes a deployment-wide master credential.
  const managementKey = () =>
    validateManagementApiKey.mockResolvedValue({
      principalType: "service",
      orgId: "org-1",
      permissions: new Set([Permission.SECRET_WRITE]),
    });

  it("should_allow_a_management_key_on_an_agent_of_its_own_org", async () => {
    managementKey();
    authz.resolveAgentScope.mockResolvedValue(AGENT_SCOPE);
    const res = await get("/probe/agent/mine/secrets", { "x-polyant-key": "pk_test" });
    expect(res.status).toBe(200);
    expect(authz.can).not.toHaveBeenCalled();
  });

  it("should_403_a_management_key_on_an_agent_of_another_org", async () => {
    managementKey();
    authz.resolveAgentScope.mockResolvedValue({ ...AGENT_SCOPE, organizationId: "org-2" });
    const res = await get("/probe/agent/theirs/secrets", { "x-polyant-key": "pk_test" });
    expect(res.status).toBe(403);
  });

  it("should_403_a_management_key_on_an_agent_that_does_not_exist", async () => {
    managementKey();
    authz.resolveAgentScope.mockResolvedValue(null);
    const res = await get("/probe/agent/ghost/secrets", { "x-polyant-key": "pk_test" });
    expect(res.status).toBe(403);
  });

  it("should_401_when_the_management_key_is_not_recognised", async () => {
    validateManagementApiKey.mockResolvedValue(null);
    const res = await get("/probe/permission", { "x-polyant-key": "pk_bogus" });
    expect(res.status).toBe(401);
  });

  it("should_confine_an_instance_api_key_to_its_own_agent", async () => {
    validateSessionToken.mockResolvedValue(null);
    findInstanceByAuthApiKey.mockResolvedValue({ slug: "mine", instanceId: "uuid-mine" });
    // The probe route does not opt into instance keys, so the fallback never
    // fires and AuthGuard rejects — the decorator, not the key, is the gate.
    const res = await get("/probe/agent/theirs/secrets", { authorization: "Bearer inst-key" });
    expect(res.status).toBe(401);
    expect(findInstanceByAuthApiKey).not.toHaveBeenCalled();
  });
});
