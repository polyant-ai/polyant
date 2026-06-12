// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Patch, Param, Body, BadRequestException } from "@nestjs/common";
import { getEnabledToolNames } from "../../instances/instance-tools.store.js";
import { listAvailableTools } from "../../agents/tools/registry.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { getAllSecretsById } from "../../instances/secrets.store.js";
import { db } from "../../database/client.js";
import { instanceTools } from "../../instances/instance-tools.schema.js";
import { tools } from "../../agents/tools/tools.schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { collectEnabledToolSecrets, attachReadableValues } from "./instance-tools.secrets-view.js";

@Controller("api/instances")
export class InstanceToolsController {
  @Get(":slug/tools/required-secrets")
  async getRequiredSecrets(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const enabledNames = await getEnabledToolNames(instance.id);
    const specs = collectEnabledToolSecrets(listAvailableTools(), enabledNames);

    // Fetch stored values only when at least one field is readable (non-sensitive);
    // true secrets are never echoed, so there is no reason to load them.
    const hasReadable = specs.some((s) => s.sensitive === false);
    const currentSecrets = hasReadable ? await getAllSecretsById(instance.id) : {};

    return { requiredSecrets: attachReadableValues(specs, currentSecrets) };
  }

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

    // Insert new manual tools
    if (toAdd.length > 0) {
      const toolRows = await db
        .select({ id: tools.id })
        .from(tools)
        .where(inArray(tools.name, toAdd));

      if (toolRows.length > 0) {
        await db
          .insert(instanceTools)
          .values(toolRows.map((t) => ({ instanceId: instance.id, toolId: t.id, source: "manual" as const })))
          .onConflictDoNothing();
      }
    }

    // Remove manual tools that were disabled
    if (toRemove.length > 0) {
      await db
        .delete(instanceTools)
        .where(
          and(
            eq(instanceTools.instanceId, instance.id),
            inArray(instanceTools.toolId, toRemove),
          ),
        );
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
