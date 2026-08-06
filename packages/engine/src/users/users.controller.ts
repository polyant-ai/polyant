// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { RequireRole } from "../auth/decorators/require-role.decorator.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PLATFORM_ADMIN_ROLE } from "../auth/user-role.js";
import { parsePagination } from "../server/utils/parse-pagination.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../management-audit/management-audit-logger.js";

@Controller("api/users")
@RequireRole(PLATFORM_ADMIN_ROLE)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  private readonly auditLogger = createManagementAuditLogger();

  /** One page of accounts, plus the total, so the caller can navigate. */
  @Get()
  async list(@Query("limit") limitStr?: string, @Query("offset") offsetStr?: string) {
    return this.users.list(parsePagination(limitStr, offsetStr));
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    return { user: await this.users.get(id) };
  }

  @Post()
  async create(
    @Body()
    body: { email?: string; name?: string; role?: string; password?: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const created = await this.users.create(body);
    // Account creation can mint a platform admin outright, so the granted role
    // key is part of the forensic record. The password (supplied or generated) is
    // NEVER audited.
    this.auditLogger.log({
      action: ManagementAuditAction.UserCreate,
      actor: toManagementAuditActor(actor),
      targetType: ManagementAuditTarget.User,
      targetId: created.user.id,
      metadata: { role: created.user.role },
    });
    return created;
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: { name?: string | null; role?: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    // RoleGuard (platform admin) on this controller guarantees actor.role is set.
    const user = await this.users.update(id, body, {
      userId: actor.userId,
      role: actor.role!,
    });
    // Only a role change is privilege-granting — a name-only PATCH is not audited.
    if (body.role !== undefined) {
      this.auditLogger.log({
        action: ManagementAuditAction.UserRoleUpdate,
        actor: toManagementAuditActor(actor),
        targetType: ManagementAuditTarget.User,
        targetId: id,
        // The service canonicalizes the role, so record the persisted value.
        metadata: { role: user.role },
      });
    }
    return { user };
  }

  @Delete(":id")
  async remove(
    @Param("id") id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.users.remove(id, actor);
    this.auditLogger.log({
      action: ManagementAuditAction.UserDelete,
      actor: toManagementAuditActor(actor),
      targetType: ManagementAuditTarget.User,
      targetId: id,
    });
    return { deleted: true };
  }

  @Post(":id/reset-password")
  async resetPassword(
    @Param("id") id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const result = await this.users.resetPassword(id);
    // An admin-forced reset is an account takeover primitive. The generated
    // password is NEVER audited.
    this.auditLogger.log({
      action: ManagementAuditAction.UserPasswordReset,
      actor: toManagementAuditActor(actor),
      targetType: ManagementAuditTarget.User,
      targetId: id,
    });
    return result;
  }
}
