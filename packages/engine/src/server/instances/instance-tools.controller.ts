// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Patch, Param, Body, BadRequestException } from "@nestjs/common";
import {
  applyManualToolChanges,
  getEnabledToolNames,
  listInstanceToolRows,
} from "../../instances/instance-tools.store.js";
import { listAvailableTools, pluginsForTools } from "../../agents/tools/registry.js";
import { resolveCatalogToolIds } from "../../agents/tools/tools-sync.js";
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
import { agentsShareOrganization, agentToolTarget } from "../../authz/agent-tenancy.js";

/**
 * Reject any `agent:{slug}` entry whose target lives in another organization.
 * The message is deliberately identical for "does not exist" and "belongs to
 * someone else" so the endpoint is not an existence oracle for other tenants'
 * agent slugs.
 */
export async function assertAgentTargetsAreSiblings(
  instanceSlug: string,
  requestedToolNames: readonly string[],
): Promise<void> {
  for (const name of requestedToolNames) {
    const targetSlug = agentToolTarget(name);
    if (!targetSlug) continue;
    if (!(await agentsShareOrganization(instanceSlug, targetSlug))) {
      throw new BadRequestException(`Unknown or inaccessible tool "${name}".`);
    }
  }
}

/**
 * Every tool the registry offers, with whether this agent has it and why. How
 * the panel names each plugin these tools come from rides along, so the list
 * reads the same after a save as after a reload.
 */
function toolsView(rows: readonly { name: string; source: string }[]) {
  const sourceByName = new Map(rows.map((r) => [r.name, r.source]));
  const result = listAvailableTools().map((t) => ({
    ...t,
    enabled: sourceByName.has(t.name),
    source: sourceByName.get(t.name) ?? null,
  }));
  return { tools: result, plugins: pluginsForTools(result.map((t) => t.name)) };
}

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
    return toolsView(await listInstanceToolRows(instance.id));
  }

  @RequirePermission(Permission.TOOL_WRITE)
  @Patch(":slug/tools")
  async updateTools(
    @Param("slug") slug: string,
    @Body() body: { enabled: string[] },
  ) {
    const instance = await findInstanceOrFail(slug);
    const enabledSet = new Set(body.enabled);

    const currentRows = await listInstanceToolRows(instance.id);

    const currentByName = new Map(currentRows.map((r) => [r.name, r]));

    // Tools to add as manual (requested but not currently enabled)
    const toAdd: string[] = [];
    for (const name of enabledSet) {
      if (!currentByName.has(name)) {
        toAdd.push(name);
      }
    }

    // An `agent:{slug}` entry hands this agent a live channel into the target's
    // pipeline, so the target must be a tenant sibling. The `tools` catalog is
    // deployment-global and holds one such row per agent that enabled its
    // `agent` channel — resolving a requested name against it unscoped would
    // let any org wire itself an `ask_` handoff into any other org's agent.
    await assertAgentTargetsAreSiblings(instance.slug, toAdd);

    // Tools to remove (currently manual but not in requested set)
    const toRemove: string[] = [];
    for (const row of currentRows) {
      if (row.source === "manual" && !enabledSet.has(row.name)) {
        toRemove.push(row.toolId);
      }
      // Cannot disable global or skill-sourced tools
      if ((row.source === "global" || row.source === "skill") && !enabledSet.has(row.name)) {
        throw new BadRequestException(
          `Cannot disable ${row.source}-sourced tool "${row.name}". It is required by the system or an active skill.`,
        );
      }
    }

    // Insert new manual tools.
    //
    // `resolveCatalogToolIds` repairs a catalog row the registry still holds, so
    // a mirror that drifted from the registry cannot make this a silent no-op —
    // which is what it was: an unresolved name simply inserted nothing, and the
    // endpoint answered 200 with the tool still disabled. A name neither side
    // knows is refused, with the message `assertAgentTargetsAreSiblings` uses so
    // "does not exist" stays indistinguishable from "not yours".
    const idsByName = toAdd.length > 0 ? await resolveCatalogToolIds(toAdd) : new Map<string, string>();
    if (toAdd.length > 0) {
      const unresolved = toAdd.filter((name) => !idsByName.has(name));
      if (unresolved.length > 0) {
        throw new BadRequestException(`Unknown or inaccessible tool "${unresolved[0]}".`);
      }
    }

    await applyManualToolChanges(instance.id, toAdd.map((name) => idsByName.get(name)!), toRemove);
    return toolsView(await listInstanceToolRows(instance.id));
  }
}
