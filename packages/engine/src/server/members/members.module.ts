// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { AuthzModule } from "../../authz/authz.module.js";
import { RoleBindingService } from "../../authz/role-binding.service.js";
import { MembersService } from "./members.service.js";
import { MembersController } from "./members.controller.js";

/**
 * Organization membership management (RBAC Stream 6). Imports AuthzModule for
 * the AuthorizationService the RoleBindingService depends on to invalidate the
 * binding cache synchronously after a mutation.
 */
@Module({
  imports: [AuthzModule],
  controllers: [MembersController],
  providers: [RoleBindingService, MembersService],
})
export class MembersModule {}
