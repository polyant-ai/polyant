// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";

export const PLATFORM_ADMIN_ONLY_KEY = "platformAdminOnly";

/**
 * The route requires CURRENT platform-admin standing, read from the database.
 *
 * Replaces `@RequireRole("platform_admin")`, which RoleGuard decided from the
 * `role` claim of a JWT valid for up to 24 hours with no revocation: promoting
 * or revoking a platform admin in the DB had no effect on these routes until
 * the next sign-in. `PermissionGuard` instead resolves the flag with the same
 * 5-minute cached read every other platform-admin bypass already uses.
 *
 * HUMAN principals only: a management API key has no platform-admin standing
 * to verify, and granting it one would make the Admin Console reachable with
 * an org-scoped key.
 */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY_KEY, true);
