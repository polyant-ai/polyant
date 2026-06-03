// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { RequireRole } from "../auth/decorators/require-role.decorator.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";

@Controller("api/users")
@RequireRole("superadmin")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  async list() {
    return { users: await this.users.list() };
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    return { user: await this.users.get(id) };
  }

  @Post()
  async create(
    @Body()
    body: { email?: string; name?: string; role?: string; password?: string },
  ) {
    return this.users.create(body);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() body: { name?: string | null; role?: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    // RoleGuard ("superadmin") on this controller guarantees actor.role is set.
    return { user: await this.users.update(id, body, { userId: actor.userId, role: actor.role! }) };
  }

  @Delete(":id")
  async remove(
    @Param("id") id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.users.remove(id, actor);
    return { deleted: true };
  }

  @Post(":id/reset-password")
  async resetPassword(@Param("id") id: string) {
    return this.users.resetPassword(id);
  }
}
