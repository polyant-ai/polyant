// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { OptoutsController } from "./optouts.controller.js";

@Module({
  controllers: [OptoutsController],
})
export class OptoutsModule {}
