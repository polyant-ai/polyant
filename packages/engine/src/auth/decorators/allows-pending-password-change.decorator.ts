// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";

export const ALLOWS_PENDING_PASSWORD_CHANGE_KEY = "auth:allows_pending_password_change";

/**
 * Reachable by an account that still has to replace its password.
 *
 * The password is replaced THROUGH the API, so the change route — plus reading
 * one's own identity — must stay open, or a forced change would lock the user
 * out for good. Every other route is refused by `AuthGuard` until the password
 * changes.
 *
 * Keep the set as small as the password-change screen needs: a route added here
 * is a route a temporary password keeps opening.
 */
export const AllowsPendingPasswordChange = () =>
  SetMetadata(ALLOWS_PENDING_PASSWORD_CHANGE_KEY, true);
