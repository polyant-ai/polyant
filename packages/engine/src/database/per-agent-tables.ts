// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every table that belongs to one agent, derived from the Drizzle schema.
 *
 * Read by the guardrails that hold a hand-assembled copy of an agent to the
 * schema it copies. They need the list DERIVED, because the failure they exist
 * for is a table nobody remembered.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Column names that make a table per-agent, under every spelling in the tree. */
const AGENT_KEYS = ["instance_id", "assistant_id"];

/** Every Drizzle table declared under `src/`, by name. */
async function allTables(): Promise<Map<string, PgTable>> {
  const tables = new Map<string, PgTable>();
  const files = readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .filter((f) => typeof f === "string" && f.endsWith(".ts") && !f.includes(".test."))
    .filter((f) => f.split("/").pop()!.includes("schema") || f.endsWith("logger.ts"));

  for (const file of files) {
    const mod: Record<string, unknown> = await import(join(SRC_ROOT, file));
    for (const value of Object.values(mod)) {
      if (is(value, PgTable)) tables.set(getTableConfig(value).name, value);
    }
  }
  return tables;
}

/**
 * The agent row itself, every table with an agent key, and every table whose
 * foreign key reaches one of those. The last part finds a child table such as
 * `event_definitions`, which names its parent and never the agent.
 */
export async function perAgentTables(): Promise<Map<string, PgTable>> {
  const all = await allTables();
  const found = new Map<string, PgTable>();
  for (const [name, table] of all) {
    if (name === "instances" || getTableConfig(table).columns.some((c) => AGENT_KEYS.includes(c.name))) {
      found.set(name, table);
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, table] of all) {
      if (found.has(name)) continue;
      const parents = getTableConfig(table).foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name);
      if (parents.some((parent) => found.has(parent))) {
        found.set(name, table);
        grew = true;
      }
    }
  }
  return found;
}
