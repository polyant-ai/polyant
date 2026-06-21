// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { tools } from "../agents/tools/tools.schema.js";

export interface SyncAgentToolArgs {
  slug: string;
  description: string | null;
  enable: boolean;
}

/**
 * Sync the `tools` catalog row for an `agent:{slug}` virtual tool.
 *
 * Enable → upsert a row so the target instance becomes selectable as a tool
 * from OTHER agents' `instance_tools` admin panel.
 * Disable → remove the row.
 *
 * The actual `ask_{slug}` tool wrapper is synthesised at runtime in
 * supervisor.buildTools(); this function only manages the catalog row so
 * the management UI can show the entry alongside regular tools.
 */
export async function syncAgentTool(args: SyncAgentToolArgs): Promise<void> {
  const name = `agent:${args.slug}`;
  if (args.enable) {
    const description =
      args.description?.trim() ||
      `Invoke the "${args.slug}" agent with a natural-language prompt.`;
    await db
      .insert(tools)
      .values({
        name,
        category: "agent",
        description,
      })
      .onConflictDoUpdate({
        target: tools.name,
        set: { description, category: "agent" },
      });
  } else {
    await db.delete(tools).where(eq(tools.name, name));
  }
}
