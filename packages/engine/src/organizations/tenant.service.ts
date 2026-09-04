// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import {
  findOrganizationById,
  isOrganizationMember,
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
   * A principal carrying no `orgId` gets `null`, NOT the default organization.
   *
   * This used to fall back to `findDefaultOrganization()`, justified by "it is
   * unreachable under `AUTHZ_ENFORCE=true`, so it changes shadow-mode behaviour
   * only". That justification was false: `GET /api/me` declares
   * `@AuthenticatedOnly()`, which short-circuits in `PermissionGuard` BEFORE any
   * scope resolution, so the fallback ran under enforcement too. It handed the
   * seed organization's slug and name — plus every one of its workspace slugs —
   * to any authenticated caller with no binding, which on a multi-org deployment
   * is another tenant's topology and, worse, makes the panel build URLs into an
   * organization the caller holds no binding in (every one of those pages then
   * 403s on its own data, which reads as a broken panel rather than as "you are
   * not a member").
   *
   * Answering `null` is the honest answer: the caller has no tenancy. The panel
   * already renders that as the tenant-unavailable state.
   */
  async getContextFor(user: AuthenticatedUser): Promise<TenantContext> {
    if (!user.orgId) {
      return { organization: null, workspaces: [] };
    }

    if (!(await isOrganizationMember(user.orgId, user.userId))) {
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
