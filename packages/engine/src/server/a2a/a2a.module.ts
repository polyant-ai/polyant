// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { A2aController } from "./a2a.controller.js";
import { A2aHandlerRegistry } from "./a2a-handler.registry.js";

@Module({
  controllers: [A2aController],
  providers: [A2aHandlerRegistry],
  exports: [A2aHandlerRegistry],
})
export class A2aModule {}
