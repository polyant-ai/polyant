// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { MembersService } from "./members.service.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";

/** Assign-role request body. */
interface AssignRoleBody {
  roleKey?: string;
}

/**
 * Organization membership management (RBAC Stream 6). Every handler requires
 * `org.member:manage` and the controller carries a dedicated throttle window —
 * membership mutations are privileged and low-frequency, so a tighter limit
 * than the global default contains brute-force enumeration of members.
 *
 * Pure HTTP bridge: all logic (org resolution, cross-org isolation, Owner-last
 * guard, cache invalidation) lives in MembersService / RoleBindingService.
 */
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller("api/organizations/:orgSlug/members")
export class MembersController {
  constructor(
    @Inject(MembersService)
    private readonly members: MembersService,
  ) {}

  private readonly auditLogger = createManagementAuditLogger();

  @RequirePermission(Permission.MEMBER_MANAGE)
  @Get()
  async list(
    @Param("orgSlug") orgSlug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { members: await this.members.list(orgSlug, user) };
  }

  @RequirePermission(Permission.MEMBER_MANAGE)
  @Put(":userId")
  async assign(
    @Param("orgSlug") orgSlug: string,
    @Param("userId") userId: string,
    @Body() body: AssignRoleBody,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const roleKey = body?.roleKey?.trim();
    if (!roleKey) {
      throw new BadRequestException("roleKey is required");
    }
    await this.members.assign(orgSlug, userId, roleKey, user);
    // A role grant can escalate a member all the way to Owner, and the upsert is
    // delete-then-insert — so `role_bindings.created_by` is destroyed by the next
    // assignment. This row is the only durable trace of the grant.
    this.auditLogger.log({
      action: ManagementAuditAction.MemberRoleAssign,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Member,
      targetId: userId,
      metadata: { orgSlug, roleKey },
    });
    return { assigned: true };
  }

  @RequirePermission(Permission.MEMBER_MANAGE)
  @Delete(":userId")
  async remove(
    @Param("orgSlug") orgSlug: string,
    @Param("userId") userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.members.remove(orgSlug, userId, user);
    this.auditLogger.log({
      action: ManagementAuditAction.MemberRemove,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Member,
      targetId: userId,
      metadata: { orgSlug },
    });
    return { removed: true };
  }
}
