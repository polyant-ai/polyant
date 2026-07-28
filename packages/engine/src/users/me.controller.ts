// SPDX-License-Identifier: AGPL-3.0-or-later

import { Body, Controller, Inject, Post } from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { AuthenticatedOnly } from "../authz/index.js";

@Controller("api/me")
export class MeController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  // Self-service: no RBAC permission fits "change my own password", but the
  // route still needs a human principal — an API key must not rotate a user's
  // credentials.
  @AuthenticatedOnly()
  @Post("password")
  async changePassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    await this.users.changeOwnPassword(actor, body);
    return { ok: true };
  }
}
