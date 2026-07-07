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
  deleteOrgScopeBinding,
  getOrgScopeRoleKey,
  getSystemRoleByKey,
  upsertOrgScopeBinding,
} from "../organizations/members.store.js";
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

  /** Set a user's org-scope role. Idempotent (replaces any existing binding). */
  async assignRole(input: AssignRoleInput): Promise<void> {
    const { organizationId, userId, roleKey, actorId } = input;
    if (!isSystemRoleKey(roleKey)) {
      throw new BadRequestException(`Unknown role: ${roleKey}`);
    }

    const role = await getSystemRoleByKey(roleKey);
    if (!role) {
      throw new BadRequestException(`Role not provisioned: ${roleKey}`);
    }

    // No self-escalation: the actor may not grant a role above its own level,
    // nor touch a member who already outranks it.
    await this.assertActorOutranks(organizationId, actorId, userId, roleKey);

    // Demoting the only Owner would orphan the organization.
    if (roleKey !== OWNER_ROLE_KEY) {
      await this.assertNotLastOwner(organizationId, userId);
    }

    await upsertOrgScopeBinding({ organizationId, userId, roleId: role.id, actorId });
    this.authz.invalidateBindingCache(userId, organizationId);
  }

  /** Remove a user's org-scope binding from an organization. */
  async removeBinding(input: RemoveBindingInput): Promise<void> {
    const { organizationId, userId, actorId } = input;
    // An actor may not remove a member who outranks it (e.g. admin → owner).
    await this.assertActorOutranks(organizationId, actorId, userId);
    await this.assertNotLastOwner(organizationId, userId);

    await deleteOrgScopeBinding(organizationId, userId);
    this.authz.invalidateBindingCache(userId, organizationId);
  }

  /**
   * Enforce the role hierarchy at the assignment/removal choke-point: an actor
   * may only grant a role at or below its own `level`, and may only modify a
   * target whose current role is at or below its own `level`. Blocks the
   * admin → owner self-escalation and protects an owner from an admin.
   *
   * ponytail: gated on `actorId` — the only production caller (MembersService)
   * always supplies it, so every HTTP path is enforced; an actor-less call
   * (system/bootstrap) intentionally skips the check.
   */
  private async assertActorOutranks(
    organizationId: string,
    actorId: string | undefined,
    targetUserId: string,
    assignedRoleKey?: SystemRoleKey,
  ): Promise<void> {
    if (!actorId) return;

    const actorLevel = await this.levelOf(organizationId, actorId);

    // Cannot grant a role above your own level.
    if (assignedRoleKey && roleLevel(assignedRoleKey) > actorLevel) {
      throw new ForbiddenException("Cannot assign a role higher than your own.");
    }

    // Cannot demote/remove a member who outranks you.
    const targetLevel = await this.levelOf(organizationId, targetUserId);
    if (targetLevel > actorLevel) {
      throw new ForbiddenException(
        "Cannot modify a member whose role is higher than your own.",
      );
    }
  }

  /** Current org-scope role level of a user; 0 when they hold no known role. */
  private async levelOf(organizationId: string, userId: string): Promise<number> {
    const roleKey = await getOrgScopeRoleKey(organizationId, userId);
    return roleKey && isSystemRoleKey(roleKey) ? roleLevel(roleKey) : 0;
  }

  /**
   * Reject a mutation that would drop the organization's last Owner. A no-op
   * when the target user is not currently an Owner.
   */
  private async assertNotLastOwner(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const currentRole = await getOrgScopeRoleKey(organizationId, userId);
    if (currentRole !== OWNER_ROLE_KEY) return;

    const owners = await countOwnerBindings(organizationId);
    if (owners <= 1) {
      throw new ConflictException(
        "Cannot remove the last Owner of the organization: assign another Owner first.",
      );
    }
  }
}
