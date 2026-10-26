// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { AuthzModule } from "../../authz/authz.module.js";
import { MonitorController } from "./monitor.controller.js";

/** The Monitor timeline. Imports AuthzModule for the per-type permission checks. */
@Module({
  imports: [AuthzModule],
  controllers: [MonitorController],
})
export class MonitorModule {}
