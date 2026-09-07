// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { UsersController } from "./users.controller.js";
import { MeController } from "./me.controller.js";
import { CredentialsController } from "./credentials.controller.js";
import { OrganizationsModule } from "../organizations/organizations.module.js";

@Module({
  imports: [OrganizationsModule],
  controllers: [UsersController, MeController, CredentialsController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
