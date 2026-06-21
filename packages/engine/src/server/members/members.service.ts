// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  listOrganizationMembers,
  resolveOrgIdBySlug,
  type OrganizationMember,
} from "../../organizations/members.store.js";
import { RoleBindingService } from "../../authz/role-binding.service.js";

/** The acting principal, narrowed to what the members façade needs. */
export interface MembersCaller {
  readonly userId: string;
  readonly orgId?: string;
}

/**
 * Management-plane service for organization membership (RBAC Stream 6).
 *
 * The PermissionGuard authorizes `org.member:manage` against the caller's own
 * org, but it cannot see the `:orgSlug` path parameter — so this service is the
 * defense-in-depth cross-org isolation choke-point: it resolves the addressed
 * org and rejects any request whose caller belongs to a different org. The
 * binding mutations themselves are delegated to RoleBindingService, which owns
 * the Owner-last guard and the synchronous cache invalidation.
 */
@Injectable()
export class MembersService {
  constructor(
    @Inject(RoleBindingService)
    private readonly roleBindings: RoleBindingService,
  ) {}

  async list(orgSlug: string, caller: MembersCaller): Promise<OrganizationMember[]> {
    const organizationId = await this.resolveAndAuthorize(orgSlug, caller);
    return listOrganizationMembers(organizationId);
  }

  async assign(
    orgSlug: string,
    userId: string,
    roleKey: string,
    caller: MembersCaller,
  ): Promise<void> {
    const organizationId = await this.resolveAndAuthorize(orgSlug, caller);
    await this.roleBindings.assignRole({
      organizationId,
      userId,
      roleKey,
      actorId: caller.userId,
    });
  }

  async remove(orgSlug: string, userId: string, caller: MembersCaller): Promise<void> {
    const organizationId = await this.resolveAndAuthorize(orgSlug, caller);
    await this.roleBindings.removeBinding({ organizationId, userId });
  }

  /**
   * Resolve the addressed org and assert the caller belongs to it. Returns the
   * resolved org id so callers never re-resolve. Throws 404 for an unknown slug,
   * 403 for a cross-org (or org-less) caller.
   */
  private async resolveAndAuthorize(
    orgSlug: string,
    caller: MembersCaller,
  ): Promise<string> {
    const organizationId = await resolveOrgIdBySlug(orgSlug);
    if (!organizationId) {
      throw new NotFoundException(`Organization ${orgSlug} not found`);
    }
    if (!caller.orgId || caller.orgId !== organizationId) {
      throw new ForbiddenException("Cross-organization access is not allowed");
    }
    return organizationId;
  }
}
