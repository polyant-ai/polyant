// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get } from "@nestjs/common";
import { getHookRegistry } from "../../hooks/hook-registry.js";
import { RequirePermission, Permission } from "../../authz/index.js";

/** Read-only catalog of registered hook functions (mirrors GET /api/tools). */
@Controller("api/hook-functions")
export class HookFunctionsController {
  // ORG_READ, not TOOL_READ: `agent.tool:read` names a capability over ONE
  // agent's tool selection, and this is the deployment-wide REGISTRY. An
  // agent-scoped key on an agent-less route is a claim the route cannot honour.
  @RequirePermission(Permission.ORG_READ)
  @Get()
  list() {
    return {
      hookFunctions: [...getHookRegistry().entries()].map(([name, def]) => ({
        name,
        description: def.description,
        requiredSecrets: def.requiredSecrets,
        mutatesResponse: def.mutatesResponse === true,
      })),
    };
  }
}
