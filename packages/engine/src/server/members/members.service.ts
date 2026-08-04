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
import { ensureDefaultMembership } from "../../organizations/organizations.store.js";
import { RoleBindingService } from "../../authz/role-binding.service.js";
import { AuthorizationService } from "../../authz/authorization.service.js";

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
    @Inject(AuthorizationService)
    private readonly authz: AuthorizationService,
  ) {}

  async list(orgSlug: string, caller: MembersCaller): Promise<OrganizationMember[]> {
    const organizationId = await this.resolveAndAuthorize(orgSlug, caller);
    return listOrganizationMembers(organizationId);
  }

  /**
   * Add a user to the organization, or change the role of one already in it.
   *
   * Since sign-in no longer provisions anybody, THIS is the only way into an
   * organization — so it has to produce a fully usable member, which means BOTH
   * rows:
   *
   *   - `role_bindings`, which `authz.can()` reads to decide permissions;
   *   - `organization_memberships`, which is what the sign-in callback reads to
   *     stamp `orgId` into the token.
   *
   * `assignRole` writes only the first. With auto-provisioning gone, an
   * admin-added user would otherwise hold a perfectly good binding, receive no
   * `orgId` at sign-in, resolve no scope, and be denied everywhere — an invited
   * colleague who cannot see anything, with nothing in the UI to explain it.
   *
   * Membership first: it grants no permission on its own, so a failure between
   * the two leaves a member who can sign in and see an empty panel, rather than a
   * binding nobody can reach.
   */
  async assign(
    orgSlug: string,
    userId: string,
    roleKey: string,
    caller: MembersCaller,
  ): Promise<void> {
    const organizationId = await this.resolveAndAuthorize(orgSlug, caller);
    await ensureDefaultMembership(organizationId, userId);
    await this.roleBindings.assignRole({
      organizationId,
      userId,
      roleKey,
      actorId: caller.userId,
    });
  }

  async remove(orgSlug: string, userId: string, caller: MembersCaller): Promise<void> {
    const organizationId = await this.resolveAndAuthorize(orgSlug, caller);
    await this.roleBindings.removeBinding({ organizationId, userId, actorId: caller.userId });
  }

  /**
   * Resolve the addressed org and assert the caller belongs to it. Returns the
   * resolved org id so callers never re-resolve. Throws 404 for an unknown slug,
   * 403 for a cross-org (or org-less) caller.
   *
   * A PLATFORM ADMIN is exempt, and that exemption is load-bearing rather than a
   * convenience. Platform admins sit above every organization and hold no
   * membership, so they carry no `orgId` — which, now that sign-in provisions
   * nobody, made this the deadlock: a fresh deployment's only privileged account
   * could not add the FIRST member to its own organization, and there is no other
   * way in. The bypass grants nothing new either: `PermissionGuard` already lets a
   * platform admin past every permission check before this code runs, so refusing
   * here only produced a 403 from the layer below.
   */
  private async resolveAndAuthorize(
    orgSlug: string,
    caller: MembersCaller,
  ): Promise<string> {
    const organizationId = await resolveOrgIdBySlug(orgSlug);
    if (!organizationId) {
      throw new NotFoundException(`Organization ${orgSlug} not found`);
    }
    if (caller.orgId === organizationId) return organizationId;
    if (await this.authz.isPlatformAdmin(caller.userId)) return organizationId;
    throw new ForbiddenException("Cross-organization access is not allowed");
  }
}
