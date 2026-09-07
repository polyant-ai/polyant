// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Patch, Param, Body, BadRequestException } from "@nestjs/common";
import { getEnabledToolNames } from "../../instances/instance-tools.store.js";
import { listAvailableTools } from "../../agents/tools/registry.js";
import { resolveCatalogToolIds } from "../../agents/tools/tools-sync.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { getAllSecretsById } from "../../instances/secrets.store.js";
import { db } from "../../database/client.js";
import { instanceTools } from "../../instances/instance-tools.schema.js";
import { tools } from "../../agents/tools/tools.schema.js";
import { eq, and, inArray } from "drizzle-orm";
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

    // Query instance_tools with source info
    const enabledRows = await db
      .select({ name: tools.name, source: instanceTools.source })
      .from(instanceTools)
      .innerJoin(tools, eq(instanceTools.toolId, tools.id))
      .where(eq(instanceTools.instanceId, instance.id));

    const enabledMap = new Map(enabledRows.map((r) => [r.name, r.source]));
    const allTools = listAvailableTools();
    const result = allTools.map((t) => ({
      ...t,
      enabled: enabledMap.has(t.name),
      source: enabledMap.get(t.name) ?? null,
    }));
    return { tools: result };
  }

  @RequirePermission(Permission.TOOL_WRITE)
  @Patch(":slug/tools")
  async updateTools(
    @Param("slug") slug: string,
    @Body() body: { enabled: string[] },
  ) {
    const instance = await findInstanceOrFail(slug);
    const enabledSet = new Set(body.enabled);

    // Get current instance tools with source info
    const currentRows = await db
      .select({ toolId: instanceTools.toolId, name: tools.name, source: instanceTools.source })
      .from(instanceTools)
      .innerJoin(tools, eq(instanceTools.toolId, tools.id))
      .where(eq(instanceTools.instanceId, instance.id));

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

    /*
      The add and the remove are ONE transaction.

      They were two independent statements with no lock. A failure after the
      insert left the agent holding both the newly enabled tools and the ones
      the operator had just switched off — and two concurrent PATCHes (two admin
      tabs, or the panel plus a script) each read the same `currentRows`, so the
      second one's delete removed tools the first had just added. What that
      endpoint controls is precisely what the agent is allowed to do.

      `recomputeInstanceTools`, the same table's sibling, already states the
      requirement in a comment and uses a transaction. This path was written
      against `db` directly.
    */
    if (toAdd.length > 0 || toRemove.length > 0) {
      await db.transaction(async (tx) => {
        if (toAdd.length > 0) {
          await tx
            .insert(instanceTools)
            .values(
              toAdd.map((name) => ({
                instanceId: instance.id,
                toolId: idsByName.get(name)!,
                source: "manual" as const,
              })),
            )
            .onConflictDoNothing();
        }
        if (toRemove.length > 0) {
          await tx
            .delete(instanceTools)
            .where(
              and(
                eq(instanceTools.instanceId, instance.id),
                inArray(instanceTools.toolId, toRemove),
              ),
            );
        }
      });
    }

    // Return updated tool list with source
    const updatedRows = await db
      .select({ name: tools.name, source: instanceTools.source })
      .from(instanceTools)
      .innerJoin(tools, eq(instanceTools.toolId, tools.id))
      .where(eq(instanceTools.instanceId, instance.id));

    const updatedMap = new Map(updatedRows.map((r) => [r.name, r.source]));
    const allTools = listAvailableTools();
    const resultTools = allTools.map((t) => ({
      ...t,
      enabled: updatedMap.has(t.name),
      source: updatedMap.get(t.name) ?? null,
    }));
    return { tools: resultTools };
  }
}
