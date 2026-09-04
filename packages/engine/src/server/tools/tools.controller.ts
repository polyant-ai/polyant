// SPDX-License-Identifier: GPL-3.0-or-later

import { Controller, Get } from "@nestjs/common";
import { listAvailableTools } from "../../agents/tools/registry.js";
import { RequirePermission, Permission } from "../../authz/index.js";

@Controller("api/tools")
export class ToolsController {
  // ORG_READ, not TOOL_READ: `agent.tool:read` names a capability over ONE
  // agent's tool selection, and this is the deployment-wide REGISTRY. An
  // agent-scoped key on an agent-less route is a claim the route cannot honour.
  @RequirePermission(Permission.ORG_READ)
  @Get()
  list() {
    return { tools: listAvailableTools() };
  }
}
