// SPDX-License-Identifier: AGPL-3.0-or-later

import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { TenantService } from "../organizations/tenant.service.js";
import { SelfService } from "../auth/decorators/self-service.decorator.js";
import { Permission, RequirePermission } from "../authz/index.js";

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
   * `@RequirePermission` is REQUIRED, not optional: PermissionGuard denies any
   * route that declares no permission once `AUTHZ_ENFORCE=true`. ORG_READ is
   * held by every system role, Viewer included. A legacy token carrying no
   * `orgId` yields no scope to authorize against, so in enforce mode it gets a
   * 403 — the frontend treats that exactly like `organization: null`, since the
   * remedy (sign in again) is the same.
   */
  @RequirePermission(Permission.ORG_READ)
  @Get()
  async context(@CurrentUser() actor: AuthenticatedUser) {
    return this.tenant.getContextFor(actor);
  }

  /**
   * Rotating your own password authorizes on identity alone, so it declares
   * `@SelfService()` instead of a permission. Without a declaration this route
   * 403s under `AUTHZ_ENFORCE=true`, which would brick the forced-password-change
   * flow the initial admin lands in on first boot.
   */
  @SelfService()
  @Post("password")
  async changePassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    await this.users.changeOwnPassword(actor, body);
    return { ok: true };
  }
}
