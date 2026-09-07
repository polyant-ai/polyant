// SPDX-License-Identifier: AGPL-3.0-or-later

import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { TenantService } from "../organizations/tenant.service.js";
import { AuthenticatedOnly } from "../authz/index.js";

@Controller("api/me")
export class MeController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TenantService) private readonly tenant: TenantService,
  ) {}

  /**
   * The caller's own tenancy, used by the admin panel to build and validate
   * tenant-scoped URLs.
   *
   * `@AuthenticatedOnly()`, not a permission: reading YOUR OWN tenancy authorizes
   * on identity, and `ORG_READ` — which this declared — resolves against an
   * organization binding, so the one caller who most needs this route (a user
   * holding no binding yet) got a 403 instead of the empty tenancy that tells the
   * panel to show them nothing. A declaration is still REQUIRED, not optional:
   * PermissionGuard denies any route that declares no permission.
   *
   * `@AuthenticatedOnly()` short-circuits BEFORE scope resolution, so unlike a
   * `@RequirePermission` route this one is reachable by a principal carrying no
   * `orgId`. That is the point — but it also means `TenantService` must decide
   * what such a caller sees, and it answers `organization: null` rather than
   * falling back to the default org.
   */
  @AuthenticatedOnly()
  @Get()
  async context(@CurrentUser() actor: AuthenticatedUser) {
    return this.tenant.getContextFor(actor);
  }

  /**
   * Rotating your own password authorizes on identity alone, so it declares
   * `@AuthenticatedOnly()` instead of a permission: no RBAC permission fits
   * "change my own password", but the route still needs a HUMAN principal — an
   * API key must not rotate a user's credentials. Without a declaration this
   * route would be denied as undeclared, which would brick the
   * forced-password-change flow the initial admin lands in on first boot.
   */
  @AuthenticatedOnly()
  @Post("password")
  async changePassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    await this.users.changeOwnPassword(actor, body);
    return { ok: true };
  }
}
