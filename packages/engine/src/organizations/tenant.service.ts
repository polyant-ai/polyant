// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import {
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
   * not an error: a JWT minted before RBAC carries no `orgId`, and the frontend
   * turns that into a "sign in again" prompt. Never throw for it.
   */
  async getContextFor(user: AuthenticatedUser): Promise<TenantContext> {
    if (!user.orgId) {
      return { organization: null, workspaces: [] };
    }

    const organization = await findOrganizationById(user.orgId);
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
