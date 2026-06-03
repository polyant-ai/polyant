// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRED_ROLES_KEY } from "./decorators/require-role.decorator.js";
import type { AuthenticatedUser } from "./auth.types.js";
import type { UserRole } from "./users.schema.js";

/**
 * Reads required roles from the @RequireRole() decorator and rejects requests
 * whose `request.user.role` does not match. Runs AFTER AuthGuard (which
 * populates request.user). Routes without @RequireRole() are unaffected.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      REQUIRED_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) {
      // AuthGuard should have rejected already; defensive guard.
      throw new ForbiddenException("Authentication required");
    }
    if (!user.role || !required.includes(user.role)) {
      throw new ForbiddenException("Insufficient role");
    }
    return true;
  }
}
