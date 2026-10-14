// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { AuthzModule } from "../../authz/authz.module.js";
import { ApiKeysController } from "./api-keys.controller.js";
import { ApiKeysService } from "./api-keys.service.js";

/** Management API keys of an organization. Imports AuthzModule for AuthorizationService. */
@Module({
  imports: [AuthzModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
})
export class ApiKeysModule {}
