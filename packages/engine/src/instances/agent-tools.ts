// SPDX-License-Identifier: AGPL-3.0-or-later

import { applyManualToolChanges, listInstanceToolRows } from "./instance-tools.store.js";
import { listAvailableTools, pluginsForTools } from "../agents/tools/registry.js";
import { resolveCatalogToolIds } from "../agents/tools/tools-sync.js";
import { agentsShareOrganization, agentToolTarget } from "../authz/agent-tenancy.js";
import { AgentRequestRefusedError } from "./agent-refusal.js";
import type { InstanceUuid } from "./identifiers.js";

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
      throw new AgentRequestRefusedError(`Unknown or inaccessible tool "${name}".`, "invalid");
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

/** The tools an agent can have, each with whether it has it and why (manual, skill, global). */
export async function listAgentTools(instanceId: InstanceUuid) {
  return toolsView(await listInstanceToolRows(instanceId));
}

/**
 * Make `enabled` the agent's set of manual tools. A tool enabled by the system
 * or by an active skill cannot be switched off here; a name nobody offers, or an
 * `agent:` handoff to another organization's agent, is refused alike.
 */
export async function setEnabledAgentTools(
  instance: { id: InstanceUuid; slug: string },
  enabled: readonly string[],
) {
    const enabledSet = new Set(enabled);

  // The request speaks only for the tools the running release offers, the
  // ones the view lists, and the agent's `agent:*` handoffs. A row of a tool
  // it does not offer stays as it is: the boot sync keeps such a row while an
  // agent references it (a newer release's tool, after a rollback), and a save
  // must neither refuse over it nor switch it off.
  const offered = new Set(listAvailableTools().map((t) => t.name));
  const currentRows = (await listInstanceToolRows(instance.id)).filter(
    (r) => offered.has(r.name) || agentToolTarget(r.name) !== null,
  );

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
      throw new AgentRequestRefusedError(
        `Cannot disable ${row.source}-sourced tool "${row.name}". It is required by the system or an active skill.`,
        "invalid",
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
      throw new AgentRequestRefusedError(`Unknown or inaccessible tool "${unresolved[0]}".`, "invalid");
    }
  }

  await applyManualToolChanges(instance.id, toAdd.map((name) => idsByName.get(name)!), toRemove);
  return toolsView(await listInstanceToolRows(instance.id));
}
