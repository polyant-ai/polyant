// SPDX-License-Identifier: AGPL-3.0-or-later

import { inArray } from "drizzle-orm";
import { instanceTools } from "./instance-tools.schema.js";
import { tools } from "../agents/tools/tools.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

function missingToolWarnings(
  toolNames: string[],
  toolRows: Array<{ id: string; name: string }>,
): ImportWarning[] {
  const foundNames = new Set(toolRows.map((r) => r.name));
  return toolNames
    .filter((name) => !foundNames.has(name))
    .map((name) => ({ type: "missing_tool" as const, message: `Tool "${name}" not found — skipped` }));
}

export async function importManualTools(
  tx: TxClient,
  instanceId: string,
  toolNames: string[],
): Promise<ImportWarning[]> {
  if (toolNames.length === 0) return [];

  const toolRows = await tx
    .select({ id: tools.id, name: tools.name })
    .from(tools)
    .where(inArray(tools.name, toolNames));

  const warnings = missingToolWarnings(toolNames, toolRows);

  if (toolRows.length > 0) {
    await tx
      .insert(instanceTools)
      .values(
        toolRows.map((t) => ({
          instanceId,
          toolId: t.id,
          source: "manual" as const,
        })),
      )
      .onConflictDoNothing();
  }

  return warnings;
}
