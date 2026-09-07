// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";
import type { PermissionKey } from "../permissions.js";

export const REQUIRE_PERMISSION_KEY = "authz:require_permission";

/**
 * Declare the RBAC permission a route requires. The PermissionGuard reads it
 * and checks it against the caller's effective bindings for the agent in scope.
 *
 * A route WITHOUT this decorator (and without `@AuthenticatedOnly()`,
 * `@PlatformAdminOnly()` or `@Public()`) is "undeclared" and is DENIED. There
 * is no shadow mode to fall back on, so forgetting the decorator breaks the
 * route loudly rather than leaving it open —
 * `server/route-authorization-guardrail.test.ts` catches it in CI first.
 */
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
