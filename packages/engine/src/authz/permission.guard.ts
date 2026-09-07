// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createLogger } from "../utils/create-logger.js";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator.js";
import {
  parseWorkspaceSlugHeader,
  WORKSPACE_SLUG_HEADER,
} from "../auth/decorators/workspace-slug.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "./decorators/require-permission.decorator.js";
import { REQUIRES_FEATURE_KEY } from "./decorators/requires-feature.decorator.js";
import { AUTHENTICATED_ONLY_KEY } from "./decorators/authenticated-only.decorator.js";
import { PLATFORM_ADMIN_ONLY_KEY } from "./decorators/platform-admin-only.decorator.js";
import { AuthorizationService } from "./authorization.service.js";
import {
  ENTITLEMENT_SERVICE,
  type EntitlementService,
} from "./entitlement.service.js";
import type { AgentScope } from "./authz.store.js";
import type { PermissionKey } from "./permissions.js";

const logger = createLogger();
const LOG_PREFIX = "authz";

/** Shape of the per-instance API-key (service) principal set by AuthGuard. */
interface InstancePrincipal {
  kind: "instance";
  instanceSlug: string;
  instanceId?: string;
}

/**
 * Shape of the org-scoped management-API-key (service) principal set by
 * AuthGuard from the `X-Polyant-Key` header. Decided purely from its own
 * permission set — never consults the user authorization service.
 */
interface ManagementKeyPrincipal {
  principalType: "service";
  orgId: string;
  permissions: ReadonlySet<PermissionKey>;
}

/** Shape of the human-user principal (subset of AuthenticatedUser). */
interface UserPrincipal {
  principalType: "user";
  userId: string;
  orgId?: string;
}

type Principal =
  | InstancePrincipal
  | ManagementKeyPrincipal
  | UserPrincipal
  | undefined;

function isInstancePrincipal(p: Principal): p is InstancePrincipal {
  return !!p && (p as InstancePrincipal).kind === "instance";
}

function isManagementKeyPrincipal(p: Principal): p is ManagementKeyPrincipal {
  return !!p && (p as ManagementKeyPrincipal).principalType === "service";
}

function isUserPrincipal(p: Principal): p is UserPrincipal {
  return !!p && (p as UserPrincipal).principalType === "user";
}

/**
 * Management-plane authorization guard (design §6.3). Registered as APP_GUARD #3
 * so it runs AFTER ThrottlerGuard (#1) and AuthGuard (#2) — the user identity is
 * already on `request.user` when this guard evaluates.
 *
 * Decision order:
 *   1. `@Public()` → allow (the route is intentionally unauthenticated).
 *   2. `@RequiresFeature(f)` and the feature is NOT licensed → deny.
 *   3. No `@RequirePermission()`: `@AuthenticatedOnly()` allows any human user;
 *      `@PlatformAdminOnly()` allows only a human whose `users.is_platform_admin`
 *      is true RIGHT NOW, read from the DB — no JWT claim is consulted. This
 *      replaces the old `@RequireRole("platform_admin")` + RoleGuard pair, which
 *      decided the same question from a 24-hour JWT claim no promotion or
 *      revocation ever reached. Otherwise the route is undeclared → deny.
 *   4. ManagementKeyPrincipal (org API key) → allow iff the permission is in
 *      the key's own permission set AND the addressed agent belongs to the
 *      key's organization.
 *   5. Platform admin (DB-backed) → bypass all permission checks.
 *   6. InstancePrincipal (per-instance API key) → allow only for its own agent.
 *   7. Resolve the agent/org scope; a cross-org mismatch denies before `can()`.
 *   8. `can()` decides.
 *
 * THERE IS NO SHADOW MODE. Every denial is a denial.
 *
 * The guard shipped with an `AUTHZ_ENFORCE` escape hatch that downgraded denials
 * to logged allows while the decorate-all sweep was in flight, and
 * `.env.example` propagated `AUTHZ_ENFORCE=false` into real deployments — so an
 * install that followed the sample ran with every `@RequirePermission` reduced
 * to a no-op and cross-org isolation off. Every mounted route now declares its
 * authorization (`server/route-authorization-guardrail.test.ts` derives the list
 * from the NestJS module graph, so a new handler cannot silently skip it), which
 * is what the flag was buying time for. So the flag is gone, not defaulted: a
 * switch that turns authorization off is not a thing to leave lying around.
 *
 * CONSEQUENCE for `AUTH_MODE=alb-oidc`: a gateway-forwarded principal carries no
 * `orgId` (`auth/alb-oidc.service.ts` cannot map the Cognito `sub` onto a local
 * user) and holds no `role_bindings`, so it resolves no scope and is denied on
 * every `@RequirePermission` route — with no flag to fall back to. Gateway mode
 * needs that identity mapping before it can be used; see CLAUDE.md.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(AuthorizationService)
    private readonly authz: AuthorizationService,
    @Inject(ENTITLEMENT_SERVICE)
    private readonly entitlement: EntitlementService,
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const feature = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRES_FEATURE_KEY,
      targets,
    );
    if (feature && !this.entitlement.isAvailable(feature)) {
      // A missing license is a capability gap, not a permission opinion.
      throw new ForbiddenException(`Feature not available: ${feature}`);
    }

    const permission = this.reflector.getAllAndOverride<PermissionKey | undefined>(
      REQUIRE_PERMISSION_KEY,
      targets,
    );
    if (!permission) {
      if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, targets)) {
        return this.handleAuthenticatedOnly(context);
      }
      if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_ONLY_KEY, targets)) {
        return this.handlePlatformAdminOnly(context);
      }
      return this.handleUndeclared(context);
    }

    const request = context.switchToHttp().getRequest();
    const principal = request.user as Principal;
    const agentSlug = this.extractAgentSlug(request);
    const addressedAgentScope = await this.assertAddressedWorkspace(
      request,
      agentSlug,
      permission,
    );

    if (isManagementKeyPrincipal(principal)) {
      return this.evaluateManagementKeyPrincipal(
        principal,
        agentSlug,
        permission,
        addressedAgentScope,
      );
    }

    if (isInstancePrincipal(principal)) {
      return this.evaluateInstancePrincipal(principal, agentSlug, permission);
    }

    if (!isUserPrincipal(principal)) {
      // AuthGuard should have rejected; defensive deny.
      return this.decide(false, permission, "no authenticated principal");
    }

    if (await this.authz.isPlatformAdmin(principal.userId)) {
      return true;
    }

    return this.evaluateUser(principal, agentSlug, permission, addressedAgentScope);
  }

  // -- branches ---------------------------------------------------------------

  /**
   * @AuthenticatedOnly lane: allow iff the principal is a human user. Service
   * principals (instance API key, management API key) and unauthenticated
   * requests are always denied — they must use @RequirePermission instead.
   */
  private handleAuthenticatedOnly(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const principal = request.user as Principal;
    if (isUserPrincipal(principal)) {
      return true;
    }
    const principalType =
      (principal as InstancePrincipal)?.kind ??
      (principal as ManagementKeyPrincipal | UserPrincipal)?.principalType ??
      "none";
    logger.warn(
      LOG_PREFIX,
      `deny @AuthenticatedOnly (non-user principal: ${principalType})`,
    );
    throw new ForbiddenException("Route requires an authenticated user principal");
  }

  /**
   * @PlatformAdminOnly lane: allow only a human principal whose
   * `users.is_platform_admin` is true RIGHT NOW. No shadow mode: a
   * deployment-level route denies unconditionally.
   */
  private async handlePlatformAdminOnly(context: ExecutionContext): Promise<boolean> {
    const principal = context.switchToHttp().getRequest().user as Principal;
    if (isUserPrincipal(principal) && (await this.authz.isPlatformAdmin(principal.userId))) {
      return true;
    }
    throw new ForbiddenException("Current platform administrator standing required");
  }

  /**
   * A route with no `@RequirePermission` and no `@AuthenticatedOnly()` /
   * `@PlatformAdminOnly()` declaration (all handled in `canActivate`) is a
   * genuine omission and fails closed.
   */
  private handleUndeclared(context: ExecutionContext): never {
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    logger.warn(LOG_PREFIX, `deny undeclared route ${route}`);
    throw new ForbiddenException("Route declares no permission");
  }

  /**
   * An instance principal acts only on its own agent. Any other target denies.
   *
   * The declared `permission` is deliberately NOT consulted: an instance API key
   * has no `role_bindings` to check it against, so for this principal type the
   * `@AllowInstanceApiKey()` decorator IS the authorization decision — reaching
   * this branch means a reviewer opted the route in.
   *
   * That makes the decorator the thing to keep honest, not this function. On a
   * route with no `:slug` there is nothing here to confine, so such a handler
   * must scope its own response (`/v1/models` → `OpenAIService.listInstances`).
   * `route-authorization-guardrail.test.ts` pins the opted-in set to exactly the
   * reviewed list, so adding the decorator to another slug-less route cannot
   * pass CI without someone changing that list deliberately.
   */
  private evaluateInstancePrincipal(
    principal: InstancePrincipal,
    agentSlug: string | undefined,
    permission: PermissionKey,
  ): boolean {
    const ownsTarget = !agentSlug || agentSlug === principal.instanceSlug;
    return this.decide(ownsTarget, permission, `instance principal ${principal.instanceSlug}`);
  }

  /**
   * A management-API-key principal carries an explicit permission set, so the
   * permission decision is membership in that set — the user authz service is
   * never consulted. The key is nonetheless bound to the organization it was
   * issued for: an agent-addressed route must resolve to an agent of that org,
   * exactly like the user branch. Skipping this check let a key of org A read
   * and overwrite the secrets, prompts and channels of every other tenant.
   */
  private async evaluateManagementKeyPrincipal(
    principal: ManagementKeyPrincipal,
    agentSlug: string | undefined,
    permission: PermissionKey,
    addressedAgentScope: AgentScope | undefined,
  ): Promise<boolean> {
    const reason = `management key (org ${principal.orgId})`;
    if (!principal.permissions.has(permission)) {
      return this.decide(false, permission, reason);
    }
    return this.assertSameOrg(
      principal.orgId,
      agentSlug,
      permission,
      reason,
      addressedAgentScope,
    );
  }

  private async evaluateUser(
    principal: UserPrincipal,
    agentSlug: string | undefined,
    permission: PermissionKey,
    addressedAgentScope: AgentScope | undefined,
  ): Promise<boolean> {
    const scope = await this.resolveScope(principal.orgId, agentSlug, addressedAgentScope);
    if (!scope) {
      return this.decide(false, permission, "unresolved scope");
    }

    // Cross-org isolation: the caller's token org must match the target scope.
    if (principal.orgId && principal.orgId !== scope.organizationId) {
      return this.decide(false, permission, "cross-org scope mismatch");
    }

    const allowed = await this.authz.can(principal.userId, scope, permission);
    return this.decide(allowed, permission, "permission check");
  }

  // -- helpers ----------------------------------------------------------------

  /**
   * Resolve the scope a permission acts within. An agent-addressed route
   * (`:slug` present) resolves to the agent's workspace+org choke-point; a
   * route without a slug acts at the caller's org level. Returns `null` when no
   * scope can be derived (the no-slug HIGH gap → caller decides, here a deny).
   */
  private async resolveScope(
    orgId: string | undefined,
    agentSlug: string | undefined,
    addressedAgentScope?: AgentScope,
  ): Promise<AgentScope | null> {
    if (agentSlug) {
      return addressedAgentScope ?? this.authz.resolveAgentScope(agentSlug);
    }
    if (orgId) {
      return { agentId: "", workspaceId: "", organizationId: orgId };
    }
    return null;
  }

  /**
   * Deny when an agent-addressed route targets an agent outside `orgId`. An
   * unknown slug resolves to no scope and denies too (fail-closed): the
   * controller's own 404 is the right answer for a caller of the owning org,
   * never a signal handed to a caller of another one.
   */
  private async assertSameOrg(
    orgId: string,
    agentSlug: string | undefined,
    permission: PermissionKey,
    reason: string,
    addressedAgentScope?: AgentScope,
  ): Promise<boolean> {
    if (!agentSlug) return this.decide(true, permission, reason);

    const scope = await this.resolveScope(orgId, agentSlug, addressedAgentScope);
    if (!scope) {
      return this.decide(false, permission, `unresolved scope — ${reason}`);
    }
    if (scope.organizationId !== orgId) {
      return this.decide(false, permission, `cross-org scope mismatch — ${reason}`);
    }
    return this.decide(true, permission, reason);
  }

  private extractAgentSlug(request: {
    params?: Record<string, string>;
  }): string | undefined {
    return request.params?.slug;
  }

  /**
   * A workspace URL segment is an address, not an authorization hint. When the
   * client supplies one for an agent route, resolve it inside that agent's
   * organization and require it to identify the owning workspace. This runs
   * before every principal-specific allow path, including platform admins.
   *
   * Requests without the header preserve the existing API contract: they can
   * still address an agent by slug alone.
   */
  private async assertAddressedWorkspace(
    request: {
      headers?: Record<string, unknown>;
    },
    agentSlug: string | undefined,
    permission: PermissionKey,
  ): Promise<AgentScope | undefined> {
    if (!agentSlug) return undefined;

    const workspaceHeader = Object.entries(request.headers ?? {}).find(
      ([name]) => name.toLowerCase() === WORKSPACE_SLUG_HEADER,
    );
    if (!workspaceHeader) return undefined;

    const workspaceSlug = parseWorkspaceSlugHeader(workspaceHeader[1]);
    if (!workspaceSlug) {
      this.decide(false, permission, "malformed workspace address");
      return undefined;
    }

    const scope = await this.authz.resolveAgentScope(agentSlug);
    if (!scope) {
      this.decide(false, permission, "unresolved workspace address");
      return undefined;
    }

    const workspaceId = await this.authz.resolveWorkspaceId(
      scope.organizationId,
      workspaceSlug,
    );
    if (workspaceId !== scope.workspaceId) {
      this.decide(false, permission, "workspace address mismatch");
      return undefined;
    }
    return scope;
  }

  /** A `false` decision throws. There is no downgrade-to-allow path. */
  private decide(allowed: boolean, permission: PermissionKey, reason: string): boolean {
    if (allowed) return true;
    logger.warn(LOG_PREFIX, `deny ${permission} (${reason})`);
    throw new ForbiddenException(`Missing permission: ${permission}`);
  }
}
