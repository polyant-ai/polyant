// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { config } from "../config.js";
import { createLogger } from "../utils/create-logger.js";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator.js";
import { REQUIRED_ROLES_KEY } from "../auth/decorators/require-role.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "./decorators/require-permission.decorator.js";
import { REQUIRES_FEATURE_KEY } from "./decorators/requires-feature.decorator.js";
import { AUTHENTICATED_ONLY_KEY } from "./decorators/authenticated-only.decorator.js";
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
 *   2. `@RequiresFeature(f)` and the feature is NOT licensed → deny. This is a
 *      hard capability gap and is enforced even in shadow mode.
 *   3. No `@RequirePermission()`: `@AuthenticatedOnly()` allows any human user;
 *      `@RequireRole()` defers to RoleGuard, which has already run. Otherwise
 *      the route is undeclared → log; deny ONLY when `AUTHZ_ENFORCE=true`
 *      (closes the fail-closed-undeclared-routes gap).
 *   4. ManagementKeyPrincipal (org API key) → allow iff the permission is in
 *      the key's own permission set AND the addressed agent belongs to the
 *      key's organization.
 *   5. Platform admin (DB-backed) → bypass all permission checks.
 *   6. InstancePrincipal (per-instance API key) → allow only for its own agent.
 *   7. Resolve the agent/org scope; a cross-org mismatch denies before `can()`.
 *   8. `can()` decides; a denial is enforced only when `AUTHZ_ENFORCE=true`.
 *
 * SHADOW MODE (`AUTHZ_ENFORCE` unset/false, the default): every would-be denial
 * is logged but downgraded to allow, so the guard observes traffic without
 * changing behaviour.
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
      // A missing license is a capability gap, not a permission opinion —
      // always denied, regardless of shadow mode.
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
      // `@RequireRole` IS an authorization declaration — RoleGuard (APP_GUARD
      // #2b, registered by AuthModule and therefore already run) hard-denies a
      // role mismatch. Treating it as undeclared made every role-gated route
      // 403 for everyone, platform admins included: the platform-admin bypass sits
      // further down, past this branch.
      const requiredRoles = this.reflector.getAllAndOverride<unknown[] | undefined>(
        REQUIRED_ROLES_KEY,
        targets,
      );
      if (requiredRoles && requiredRoles.length > 0) {
        return true;
      }
      return this.handleUndeclared(context);
    }

    const request = context.switchToHttp().getRequest();
    const principal = request.user as Principal;
    const agentSlug = this.extractAgentSlug(request);

    if (isManagementKeyPrincipal(principal)) {
      return this.evaluateManagementKeyPrincipal(principal, agentSlug, permission);
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

    return this.evaluateUser(principal, agentSlug, permission);
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
    if (config.authz.enforce) {
      logger.warn(LOG_PREFIX, `deny @AuthenticatedOnly (non-user principal, enforce)`);
      throw new ForbiddenException("Route requires an authenticated user principal");
    }
    const principalType =
      (principal as InstancePrincipal)?.kind ??
      (principal as ManagementKeyPrincipal | UserPrincipal)?.principalType ??
      "none";
    logger.info(
      LOG_PREFIX,
      `shadow: @AuthenticatedOnly non-user principal allowed (principal type: ${principalType})`,
    );
    return true;
  }

  /**
   * A route with no `@RequirePermission` and no `@AuthenticatedOnly()` /
   * `@RequireRole(...)` declaration (both handled in `canActivate`) is a genuine
   * omission and fails closed under enforcement.
   */
  private handleUndeclared(context: ExecutionContext): boolean {
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (config.authz.enforce) {
      logger.warn(LOG_PREFIX, `deny undeclared route ${route} (enforce)`);
      throw new ForbiddenException("Route declares no permission");
    }
    logger.info(LOG_PREFIX, `shadow: undeclared route ${route} allowed`);
    return true;
  }

  private evaluateInstancePrincipal(
    principal: InstancePrincipal,
    agentSlug: string | undefined,
    permission: PermissionKey,
  ): boolean {
    // An instance principal acts only on its own agent. Any other target denies.
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
  ): Promise<boolean> {
    const reason = `management key (org ${principal.orgId})`;
    if (!principal.permissions.has(permission)) {
      return this.decide(false, permission, reason);
    }
    return this.assertSameOrg(principal.orgId, agentSlug, permission, reason);
  }

  private async evaluateUser(
    principal: UserPrincipal,
    agentSlug: string | undefined,
    permission: PermissionKey,
  ): Promise<boolean> {
    const scope = await this.resolveScope(principal.orgId, agentSlug);
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
  ): Promise<AgentScope | null> {
    if (agentSlug) {
      return this.authz.resolveAgentScope(agentSlug);
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
  ): Promise<boolean> {
    if (!agentSlug) return this.decide(true, permission, reason);

    const scope = await this.resolveScope(orgId, agentSlug);
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
   * Apply the shadow/enforce policy: in enforce mode a `false` decision throws;
   * in shadow mode it is logged and downgraded to allow. A `true` decision
   * always allows.
   */
  private decide(allowed: boolean, permission: PermissionKey, reason: string): boolean {
    if (allowed) return true;
    if (config.authz.enforce) {
      logger.warn(LOG_PREFIX, `deny ${permission} (${reason}, enforce)`);
      throw new ForbiddenException(`Missing permission: ${permission}`);
    }
    logger.info(LOG_PREFIX, `shadow: would deny ${permission} (${reason})`);
    return true;
  }
}
