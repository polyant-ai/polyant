// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import {
  countOwnerBindings,
  deleteOrganizationMember,
  getOrgScopeRoleKey,
  getSystemRoleByKey,
  upsertOrganizationMemberRole,
  withOrganizationMemberLock,
} from "../organizations/members.store.js";
import type { DbExecutor } from "../database/client.js";
import { AuthorizationService } from "./authorization.service.js";
import { SYSTEM_ROLE_KEYS, roleLevel, type SystemRoleKey } from "./permissions.js";

const OWNER_ROLE_KEY: SystemRoleKey = "owner";

export interface AssignRoleInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly roleKey: string;
  /** The acting user, recorded as `created_by` on the binding. */
  readonly actorId?: string;
}

export interface RemoveBindingInput {
  readonly organizationId: string;
  readonly userId: string;
  /** The acting user, ranked against the target to block escalation. */
  readonly actorId?: string;
}

function isSystemRoleKey(value: string): value is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);
}

/**
 * The org-scope role assignment / removal choke-point (RBAC Stream 6). Every
 * binding mutation flows through here so the two cross-cutting concerns are
 * applied exactly once and in the right order:
 *
 *   1. Owner-last guard — the organization must never be left without an Owner,
 *      whether by demoting or by removing its only Owner. This protects against
 *      an accidental lock-out (design: Org Ownership Transfer, HIGH gap).
 *   2. Synchronous cache invalidation — after a successful write the user's
 *      cached bindings are dropped immediately (reusing #106's BindingCache via
 *      `AuthorizationService.invalidateBindingCache`), so a permission change
 *      takes effect on the very next request instead of after the TTL window.
 */
@Injectable()
export class RoleBindingService {
  constructor(
    @Inject(AuthorizationService)
    private readonly authz: AuthorizationService,
  ) {}

  /** Add a member or replace their org-scope role. */
  async assignMemberRole(input: AssignRoleInput): Promise<void> {
    const { organizationId, userId, roleKey, actorId } = input;
    if (!isSystemRoleKey(roleKey)) {
      throw new BadRequestException(`Unknown role: ${roleKey}`);
    }

    await withOrganizationMemberLock(organizationId, async (transaction) => {
      const role = await getSystemRoleByKey(roleKey, transaction);
      if (!role) {
        throw new BadRequestException(`Role not provisioned: ${roleKey}`);
      }

      await this.assertActorOutranks(
        organizationId,
        actorId,
        userId,
        roleKey,
        transaction,
      );

      if (roleKey !== OWNER_ROLE_KEY) {
        await this.assertNotLastOwner(organizationId, userId, transaction);
      }

      await upsertOrganizationMemberRole(
        { organizationId, userId, roleId: role.id, actorId },
        transaction,
      );
    });
    this.authz.invalidateBindingCache(userId, organizationId);
  }

  /** Remove a member and every role binding they hold in an organization. */
  async removeMember(input: RemoveBindingInput): Promise<void> {
    const { organizationId, userId, actorId } = input;
    await withOrganizationMemberLock(organizationId, async (transaction) => {
      await this.assertActorOutranks(organizationId, actorId, userId, undefined, transaction);
      await this.assertNotLastOwner(organizationId, userId, transaction);
      await deleteOrganizationMember(organizationId, userId, transaction);
    });
    this.authz.invalidateBindingCache(userId, organizationId);
  }

  /**
   * Enforce the role hierarchy at the assignment/removal choke-point: an actor
   * may only grant a role at or below its own `level`, and may only modify a
   * target whose current role is at or below its own `level`. Blocks the
   * admin → owner self-escalation and protects an owner from an admin.
   *
   * Gated on `actorId` — the only production caller (MembersService) always
   * supplies it, so every HTTP path is enforced; an actor-less call
   * (system/bootstrap) intentionally skips the check.
   *
   * A platform admin RANKS ABOVE EVERY ROLE (rank infinity). It holds no
   * org-scope binding by design — `MembersService.resolveAndAuthorize` exempts
   * it from org membership one layer above — so `levelOf` reads 0 for it, below
   * even `viewer` (10), and every assignment it attempted was rejected here.
   * That defeated the exemption granted above and left the deployment with no
   * actor able to bootstrap an Owner.
   */
  private async assertActorOutranks(
    organizationId: string,
    actorId: string | undefined,
    targetUserId: string,
    assignedRoleKey?: SystemRoleKey,
    executor?: DbExecutor,
  ): Promise<void> {
    if (!actorId) return;
    if (await this.authz.isPlatformAdmin(actorId)) return;

    const actorLevel = await this.levelOf(organizationId, actorId, executor);

    // Cannot grant a role above your own level.
    if (assignedRoleKey && roleLevel(assignedRoleKey) > actorLevel) {
      throw new ForbiddenException("Cannot assign a role higher than your own.");
    }

    // Cannot demote/remove a member who outranks you.
    const targetLevel = await this.levelOf(organizationId, targetUserId, executor);
    if (targetLevel > actorLevel) {
      throw new ForbiddenException(
        "Cannot modify a member whose role is higher than your own.",
      );
    }
  }

  /** Current org-scope role level of a user; 0 when they hold no known role. */
  private async levelOf(
    organizationId: string,
    userId: string,
    executor?: DbExecutor,
  ): Promise<number> {
    const roleKey = await getOrgScopeRoleKey(organizationId, userId, executor);
    return roleKey && isSystemRoleKey(roleKey) ? roleLevel(roleKey) : 0;
  }

  /**
   * Reject a mutation that would drop the organization's last Owner. A no-op
   * when the target user is not currently an Owner.
   */
  private async assertNotLastOwner(
    organizationId: string,
    userId: string,
    executor?: DbExecutor,
  ): Promise<void> {
    const currentRole = await getOrgScopeRoleKey(organizationId, userId, executor);
    if (currentRole !== OWNER_ROLE_KEY) return;

    const owners = await countOwnerBindings(organizationId, executor);
    if (owners <= 1) {
      throw new ConflictException(
        "Cannot remove the last Owner of the organization: assign another Owner first.",
      );
    }
  }
}
