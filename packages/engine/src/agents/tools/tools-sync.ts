// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, like, not, notInArray } from "drizzle-orm";
import { getToolRegistry, requiredSecretKeys } from "./registry.js";
import { db } from "../../database/client.js";
import { tools } from "./tools.schema.js";

/**
 * Set of tool names that are considered "global" — always available to every
 * instance regardless of per-instance tool configuration.
 *
 * Includes both current and future (post-rename) names so the sync works
 * across the Fase 1 → Fase 4 transition.
 */
const GLOBAL_TOOLS = new Set<string>([]);

/**
 * Upsert every tool from the in-memory registry into the `tools` DB table,
 * and hard-delete rows for tools that no longer exist in the registry.
 */
export async function syncToolsToDb(): Promise<void> {
  const registry = getToolRegistry();
  const registryNames: string[] = [];

  await db.transaction(async (tx) => {
    for (const [name, def] of registry) {
      registryNames.push(name);

      // DB stores only the flat list of secret keys (jsonb string[]). The richer
      // shape (type/choices/label/...) lives in-memory in the registry and is
      // exposed via the API — no need to persist it.
      const secretKeys = requiredSecretKeys(def.requiredSecrets);

      await tx
        .insert(tools)
        .values({
          name,
          description: def.description,
          category: def.category ?? "general",
          requiredSecrets: secretKeys,
          isMeta: def.metaTool ?? false,
          isGlobal: GLOBAL_TOOLS.has(name),
          isHarness: def.harness ?? false,
        })
        .onConflictDoUpdate({
          target: tools.name,
          set: {
            description: def.description,
            category: def.category ?? "general",
            requiredSecrets: secretKeys,
            isMeta: def.metaTool ?? false,
            isGlobal: GLOBAL_TOOLS.has(name),
            isHarness: def.harness ?? false,
            syncedAt: new Date(),
          },
        });
    }

    // Hard-delete tools that are no longer in the registry.
    // EXCLUDE virtual `agent:*` rows: they are not in the static registry
    // (they are upserted by `syncAgentTool` when the callee enables its
    // `agent` channel). Deleting them here would cascade through
    // agent_tools FK and wipe per-agent agent invocation bindings.
    if (registryNames.length > 0) {
      await tx
        .delete(tools)
        .where(and(notInArray(tools.name, registryNames), not(like(tools.name, "agent:%"))));
    } else {
      // If registry is empty, still preserve agent:* rows.
      await tx.delete(tools).where(not(like(tools.name, "agent:%")));
    }
  });
}
