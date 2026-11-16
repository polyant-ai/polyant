// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Patch, Param, Body } from "@nestjs/common";
import { z } from "zod";
import { getEnabledToolNames } from "../../instances/instance-tools.store.js";
import { listAvailableTools } from "../../agents/tools/registry.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { getAllSecretsById } from "../../instances/secrets.store.js";
import {
  collectInstanceRequiredSecrets,
  enabledHookSecretSources,
  attachReadableValues,
} from "./instance-tools.secrets-view.js";
import { listHooks } from "../../hooks/hooks.store.js";
import { getHookRegistry } from "../../hooks/hook-registry.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { parseBody } from "../utils/parse-body.js";
import { listAgentTools, setEnabledAgentTools } from "../../instances/agent-tools.js";
import { refusalsAsHttp } from "./refusal-to-http.js";

/**
 * The complete list of manual tools the agent keeps. Required: a missing list
 * would read as "none" and switch every manual tool off.
 */
const UpdateToolsSchema = z.object({ enabled: z.array(z.string()) });

@Controller("api/instances")
export class InstanceToolsController {
  @RequirePermission(Permission.TOOL_READ)
  @Get(":slug/tools/required-secrets")
  async getRequiredSecrets(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const enabledToolNames = await getEnabledToolNames(instance.id);
    // Aggregate the secrets of BOTH enabled tools and enabled hooks, so a hook that
    // declares a secret surfaces in the agent config exactly like a tool's.
    const hookSources = enabledHookSecretSources(
      await listHooks(instance.id),
      (name) => getHookRegistry().get(name),
    );
    const specs = collectInstanceRequiredSecrets(listAvailableTools(), enabledToolNames, hookSources);

    // Fetch stored values only when at least one field is readable (non-sensitive);
    // true secrets are never echoed, so there is no reason to load them.
    const hasReadable = specs.some((s) => s.sensitive === false);
    const currentSecrets = hasReadable ? await getAllSecretsById(instance.id) : {};

    return { requiredSecrets: attachReadableValues(specs, currentSecrets) };
  }

  @RequirePermission(Permission.TOOL_READ)
  @Get(":slug/tools")
  async getTools(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    return listAgentTools(instance.id);
  }

  @RequirePermission(Permission.TOOL_WRITE)
  @Patch(":slug/tools")
  async updateTools(
    @Param("slug") slug: string,
    @Body() rawBody: unknown,
  ) {
    const { enabled } = parseBody(UpdateToolsSchema, rawBody);
    const instance = await findInstanceOrFail(slug);
    return refusalsAsHttp(() => setEnabledAgentTools(instance, enabled));
  }
}
