// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";

export const IS_SELF_SERVICE_KEY = "isSelfService";

/**
 * Marks a route whose only authorization requirement is authentication: the
 * caller acts on their own identity, so no RBAC scope applies. Rotating your
 * own password is the archetype.
 *
 * This is NOT `@Public()` — AuthGuard still has to establish who the caller is.
 * It exists because `PermissionGuard` denies any route that declares no
 * permission once `AUTHZ_ENFORCE=true`, and a self-service route has no
 * honest permission to declare: every candidate (`org:read`) would be a lie
 * that also fails for principals carrying no organization.
 */
export const SelfService = () => SetMetadata(IS_SELF_SERVICE_KEY, true);
