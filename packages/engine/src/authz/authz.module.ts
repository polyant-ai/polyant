// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { AuthorizationService } from "./authorization.service.js";
import {
  AUTHORIZATION_STRATEGY,
  createAuthorizationStrategy,
} from "./authorization-strategy.js";
import {
  ENTITLEMENT_SERVICE,
  OssEntitlementService,
} from "./entitlement.service.js";
import { PermissionGuard } from "./permission.guard.js";

/**
 * RBAC authorization module (Stream 3). Wires the OSS strategy + entitlement
 * service, the AuthorizationService façade, and registers the PermissionGuard
 * as the THIRD global guard.
 *
 * Global guard execution order (registration order across the module graph):
 *   1. ThrottlerGuard  — ServerModule providers (rate limit)
 *   2. AuthGuard       — AuthModule (authenticate, populate request.user)
 *   3. PermissionGuard — here (authorize the authenticated principal)
 *
 * RoleGuard (also AuthModule) sits between Auth and Permission for the legacy
 * `@RequireRole()` endpoints. The PermissionGuard relies on `request.user`
 * already being populated, so it MUST stay after AuthGuard — guaranteed by
 * importing AuthzModule after AuthModule in ServerModule.
 *
 * The strategy + entitlement bindings are factory/class providers so the EE
 * build can swap them without a dynamic import in the hot path.
 */
@Module({
  providers: [
    Reflector,
    {
      provide: AUTHORIZATION_STRATEGY,
      useFactory: createAuthorizationStrategy,
    },
    {
      provide: ENTITLEMENT_SERVICE,
      useClass: OssEntitlementService,
    },
    AuthorizationService,
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
  exports: [AuthorizationService, ENTITLEMENT_SERVICE],
})
export class AuthzModule {}
