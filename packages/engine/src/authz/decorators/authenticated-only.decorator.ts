// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";

export const AUTHENTICATED_ONLY_KEY = "authz:authenticated_only";

/**
 * Marks a route as reachable by ANY authenticated user with no specific RBAC
 * permission (self-service '/me' routes). The PermissionGuard allows it iff
 * the principal is a user principal; service/instance principals are denied.
 */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY_KEY, true);
