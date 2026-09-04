// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { instancePrompts } from "./prompts.schema.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { TxClient } from "./import.types.js";

export async function importPrompts(
  tx: TxClient,
  instanceId: string,
  prompts: ExportInstanceData["prompts"],
): Promise<void> {
  for (const p of prompts) {
    // Anti-resurrection: the 08-datetime section was removed with the datetime
    // flag; drop it from any legacy bundle so an import can't recreate it.
    if (p.sectionKey === "08-datetime") continue;
    await tx
      .insert(instancePrompts)
      .values({
        instanceId,
        sectionKey: p.sectionKey,
        title: p.title,
        content: p.content,
      })
      .onConflictDoUpdate({
        target: [instancePrompts.instanceId, instancePrompts.sectionKey],
        set: { title: p.title, content: p.content, updatedAt: sql`now()` },
      });
  }
}
