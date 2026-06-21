// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";
import type { PermissionKey } from "../permissions.js";

export const REQUIRE_PERMISSION_KEY = "authz:require_permission";

/**
 * Declare the RBAC permission a route requires. The PermissionGuard reads it
 * and checks it against the caller's effective bindings for the agent in scope.
 *
 * A route WITHOUT this decorator is "undeclared" — in shadow mode that is
 * logged and allowed; once `AUTHZ_ENFORCE=true` it fails closed (the
 * fail-closed-undeclared-routes gap this stream closes).
 */
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
