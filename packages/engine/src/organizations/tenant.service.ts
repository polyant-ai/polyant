// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import {
  findDefaultOrganization,
  findOrganizationById,
  listWorkspacesByOrganization,
  type WorkspaceIdentity,
} from "./organizations.store.js";

/**
 * What the admin panel needs to render tenant-scoped URLs: which organization
 * the caller acts within, and which workspaces that organization holds.
 *
 * `isPlatformAdmin` is deliberately absent — platform-admin status is resolved
 * from the DB on each privileged check so it stays revocable (see
 * `AuthenticatedUser`), and no consumer needs it here yet.
 */
export interface TenantContext {
  readonly organization: { readonly slug: string; readonly name: string } | null;
  readonly workspaces: readonly WorkspaceIdentity[];
}

@Injectable()
export class TenantService {
  /**
   * Resolve the caller's own tenancy. `organization: null` is a VALID answer,
   * not an error — the frontend turns it into a "sign in again" prompt, so
   * never throw for it.
   *
   * A principal carrying no `orgId` falls back to the default organization
   * rather than to `null`. Two things arrive that way: a session token minted
   * before the claim existed, which re-signing in does fix, and a
   * gateway-forwarded identity — `AUTH_MODE=alb-oidc` never stamps the claim
   * (see `alb-oidc.service.ts`), so there "sign in again" is advice no user can
   * act on, and without this fallback the whole tenant-scoped panel is a dead
   * end. The fallback grants nothing: these slugs only build admin-panel URLs,
   * every data endpoint authorizes on its own, and migration 0051 seeds exactly
   * one organization. It is also unreachable under `AUTHZ_ENFORCE=true` —
   * `PermissionGuard` derives no scope from a principal without `orgId` and
   * denies before this runs — so it changes shadow-mode behaviour only.
   */
  async getContextFor(user: AuthenticatedUser): Promise<TenantContext> {
    const organization = user.orgId
      ? await findOrganizationById(user.orgId)
      : await findDefaultOrganization();
    if (!organization) {
      return { organization: null, workspaces: [] };
    }

    const workspaces = await listWorkspacesByOrganization(organization.id);
    return {
      organization: { slug: organization.slug, name: organization.name },
      workspaces,
    };
  }
}
