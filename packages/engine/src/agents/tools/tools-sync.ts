// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, inArray, like, not, notInArray } from "drizzle-orm";
import { getToolRegistry, requiredSecretKeys, type ToolDefinition } from "./registry.js";
import { db } from "../../database/client.js";
import { tools } from "./tools.schema.js";
import { instanceTools } from "../../instances/instance-tools.schema.js";
import { skillTools } from "../../skills/schema.js";
/**
 * Set of tool names that are considered "global" — always available to every
 * instance regardless of per-instance tool configuration.
 *
 * Includes both current and future (post-rename) names so the sync works
 * across the Fase 1 → Fase 4 transition.
 */
const GLOBAL_TOOLS = new Set<string>([]);

/** The catalog row a registry definition maps to — one place, so the boot sync
 *  and the on-demand repair below can never write a row two different ways. */
function catalogRow(name: string, def: ToolDefinition) {
  return {
    name,
    description: def.description,
    category: def.category ?? "general",
    // DB stores only the flat list of secret keys (jsonb string[]). The richer
    // shape (type/choices/label/...) lives in-memory in the registry and is
    // exposed via the API — no need to persist it.
    requiredSecrets: requiredSecretKeys(def.requiredSecrets),
    isMeta: def.metaTool ?? false,
    isGlobal: GLOBAL_TOOLS.has(name),
    isHarness: def.harness ?? false,
  };
}

/**
 * Upsert every tool from the in-memory registry into the `tools` DB table, and
 * delete the rows of tools that no longer exist in the registry and that no
 * agent or skill references.
 */
export async function syncToolsToDb(): Promise<void> {
  const registry = getToolRegistry();
  const registryNames: string[] = [];

  await db.transaction(async (tx) => {
    for (const [name, def] of registry) {
      registryNames.push(name);
      const row = catalogRow(name, def);

      await tx
        .insert(tools)
        .values(row)
        .onConflictDoUpdate({
          target: tools.name,
          set: { ...row, syncedAt: new Date() },
        });
    }

    // A row absent from the registry is pruned only when nothing references it.
    // An agent's enablement and a skill's tool link both point at the row with
    // `onDelete: cascade`, so deleting a referenced row would delete them too,
    // and a later boot that knows the tool again would not bring them back.
    // That happens to core tools as well as plugin ones: a rollback, or an
    // older replica restarting during a deploy, does not know a tool the newer
    // release added; a plugin can fail to load transiently (version skew,
    // PLUGIN_DIRS unmounted, import crash). A referenced row simply stays: the
    // runtime offers only the tools the registry holds, and the next boot that
    // loads the tool finds its enablements intact. Unreferenced rows (a removed
    // tool nobody uses) are pruned instead of lingering as catalog clutter.
    // Virtual `agent:*` rows legitimately have no registry entry and are
    // managed by syncAgentTool().
    /*
      `selectDistinct`, because the row count of `instance_tools` is agents ×
      enabled tools while the number of DISTINCT tools is bounded by the
      registry. 500 agents × 60 tools bound 30 000 parameters into the
      statement below, of which at most ~60 were unique; past roughly 1 100
      agents that exceeds PostgreSQL's 65 535-parameter limit and
      `syncToolsToDb` throws inside the boot transaction, so the catalog never
      syncs at all.
    */
    const enabledRows = await tx.selectDistinct({ id: instanceTools.toolId }).from(instanceTools);
    const linkedRows = await tx.selectDistinct({ id: skillTools.toolId }).from(skillTools);
    const referencedToolIds = [...new Set([...enabledRows, ...linkedRows].map((r) => r.id))];

    await tx
      .delete(tools)
      .where(
        and(
          // Registry empty (catastrophic load failure): preserve every namespaced row.
          registryNames.length > 0 ? notInArray(tools.name, registryNames) : not(like(tools.name, "%:%")),
          not(like(tools.name, "agent:%")),
          referencedToolIds.length > 0 ? notInArray(tools.id, referencedToolIds) : undefined,
        ),
      );
  });
}

/**
 * Resolve catalog ids for `names`, materializing any row the REGISTRY holds and
 * the catalog is missing. Returns name → id; a name in neither is absent from
 * the map, and the caller refuses it.
 *
 * This exists because the two sides of the Tools tab read different sources: the
 * list offers what the registry holds, the write resolves ids through the
 * catalog. The catalog is a mirror maintained at boot, so any drift turned every
 * enable of an affected tool into a SILENT no-op — the insert resolved zero ids,
 * the endpoint answered 200, and the panel reported a successful save with every
 * switch back to off. (Drift is not hypothetical: one boot whose registry lost
 * the core tools prunes every flat catalog row, and `instance_tools.tool_id`
 * cascades, so the agents lose the enablement too.)
 *
 * Repairing the mirror here — rather than only refusing — keeps "the registry is
 * the authority, the catalog is its mirror" true at the moment the disagreement
 * is discovered, instead of requiring a reboot to make the panel honest again.
 */
export async function resolveCatalogToolIds(
  names: readonly string[],
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();

  const select = async (wanted: readonly string[]) =>
    wanted.length === 0
      ? []
      : await db
          .select({ id: tools.id, name: tools.name })
          .from(tools)
          .where(inArray(tools.name, [...wanted]));

  const byName = new Map((await select(names)).map((r) => [r.name, r.id]));

  // Missing rows the registry can rebuild. A name the registry does not hold
  // either (a stale `agent:{slug}` the channel no longer publishes, a tool that
  // was removed) is deliberately left unresolved.
  const registry = getToolRegistry();
  const repairable = names.filter((name) => !byName.has(name) && registry.has(name));
  if (repairable.length === 0) return byName;

  for (const name of repairable) {
    const def = registry.get(name)!;
    await db
      .insert(tools)
      .values(catalogRow(name, def))
      .onConflictDoNothing({ target: tools.name });
  }

  for (const row of await select(repairable)) byName.set(row.name, row.id);
  return byName;
}
