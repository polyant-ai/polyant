// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { resolveOrgIdBySlug } from "../../organizations/members.store.js";
import { AuthorizationService } from "../../authz/authorization.service.js";
import { Permission, SYSTEM_ROLE_PERMISSIONS } from "../../authz/permissions.js";
import {
  createManagementApiKey,
  deleteManagementApiKey,
  listManagementApiKeys,
  type ManagementApiKeySummary,
} from "../../auth/management-api-keys.store.js";
import type { AuthenticatedUser, ServicePrincipal } from "../../auth/auth.types.js";

/** Whoever the guards let through: a person, or a management key. */
export type ApiKeysCaller =
  | Pick<AuthenticatedUser, "principalType" | "userId" | "email">
  | ServicePrincipal;

/**
 * Issuing and revoking management API keys for one organization.
 *
 * The route declares `org:write`, so `PermissionGuard` has already checked the
 * permission against the caller's own organization. This service adds the two
 * checks the guard cannot make:
 *
 *   - A key never issues or revokes keys. A key carries the Owner set,
 *     `org:write` included, so the guard lets it through; refusing it here
 *     keeps a leaked key from minting a successor that outlives its
 *     revocation, or from revoking the keys that would be used to contain it.
 *     A key may LIST the keys of its own organization, which reveals no
 *     secret and is what `polyant-cli apikey list` needs.
 *   - The organization in the URL is the one acted on. The guard never sees
 *     `:orgSlug`, so `org:write` is checked again against that organization's
 *     own bindings, or for a key, against the organization it belongs to. An
 *     unknown slug and a refused one answer the same 403, so the route does
 *     not reveal which organizations exist.
 *
 * A platform admin passes both, as on every other management route: they sit
 * above every organization and hold no binding inside it.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(AuthorizationService)
    private readonly authz: AuthorizationService,
  ) {}

  async list(orgSlug: string, caller: ApiKeysCaller | undefined): Promise<ManagementApiKeySummary[]> {
    if (caller?.principalType === "service") {
      const organizationId = await resolveOrgIdBySlug(orgSlug);
      if (organizationId === null || organizationId !== caller.orgId) {
        throw new ForbiddenException(`Missing permission: ${Permission.ORG_WRITE}`);
      }
      return listManagementApiKeys(organizationId);
    }
    const organizationId = await this.authorize(orgSlug, caller);
    return listManagementApiKeys(organizationId);
  }

  /**
   * Every key gets the full Owner permission set. Only an Owner (or a platform
   * admin) can reach this, so the key never holds more than its issuer, and a
   * narrower set would need a permission picker this build does not offer.
   */
  async create(
    orgSlug: string,
    input: { name: string; expiresAt: Date | null },
    caller: ApiKeysCaller | undefined,
  ): Promise<{ key: ManagementApiKeySummary; token: string }> {
    const organizationId = await this.authorize(orgSlug, caller);
    return createManagementApiKey({
      organizationId,
      name: input.name,
      permissions: SYSTEM_ROLE_PERMISSIONS.owner,
      expiresAt: input.expiresAt,
    });
  }

  async remove(orgSlug: string, keyId: string, caller: ApiKeysCaller | undefined): Promise<void> {
    const organizationId = await this.authorize(orgSlug, caller);
    if (!(await deleteManagementApiKey(organizationId, keyId))) {
      throw new NotFoundException(`API key ${keyId} not found`);
    }
  }

  private async authorize(orgSlug: string, caller: ApiKeysCaller | undefined): Promise<string> {
    if (caller?.principalType !== "user") {
      throw new ForbiddenException(
        "Management API keys are issued and revoked from a signed-in session, never with a key",
      );
    }
    const organizationId = await resolveOrgIdBySlug(orgSlug);
    if (await this.authz.isPlatformAdmin(caller.userId)) {
      if (!organizationId) throw new NotFoundException(`Organization ${orgSlug} not found`);
      return organizationId;
    }
    const allowed =
      organizationId !== null &&
      (await this.authz.can(
        caller.userId,
        { agentId: "", workspaceId: "", organizationId },
        Permission.ORG_WRITE,
      ));
    if (!allowed) throw new ForbiddenException(`Missing permission: ${Permission.ORG_WRITE}`);
    return organizationId;
  }
}
