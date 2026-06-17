// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get } from "@nestjs/common";
import { listAvailableTools } from "../../agents/tools/registry.js";
import { RequirePermission, Permission } from "../../authz/index.js";

@Controller("api/tools")
export class ToolsController {
  @RequirePermission(Permission.TOOL_READ)
  @Get()
  list() {
    return { tools: listAvailableTools() };
  }
}
