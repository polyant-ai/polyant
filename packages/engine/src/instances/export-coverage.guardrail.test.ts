// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An agent restored from a bundle is the agent that was exported, or someone
 * wrote down which part of it is not.
 *
 * The bundle is assembled by hand and the schema is not. A column or a per-agent
 * table added without a matching bundle field produces the worst possible
 * failure: export says OK, import says OK, and the restored agent differs from
 * the original in a way nobody sees until it matters. It happened with
 * `thinking_level`, so a reasoning agent came back thinking at a different
 * depth, and with every readable tool and hook parameter, which came back as a
 * key to fill in.
 *
 * Every list the checks walk is DERIVED from the Drizzle schema and the bundle's
 * Zod schema: the agent row's columns, the per-agent tables, and the columns of
 * each table a bundle section carries. What a human supplies is the verdict for
 * what the bundle deliberately leaves behind, and the reasons are the
 * interesting part: runtime state, credentials, and consent records are all
 * things a copy must NOT carry.
 *
 * A field that reaches the bundle schema still has to be written by BOTH import
 * paths in `import.service.ts`; this file cannot see those.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getTableConfig } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";
import { exportInstanceDataSchema } from "./export.schema.js";
import { perAgentTables } from "../database/per-agent-tables.js";

/** Columns of `instances` that are deliberately not bundle fields. */
const COLUMNS_NOT_EXPORTED: Record<string, string> = {
  id: "The row's own uuid. An import creates a new row; carrying the old id would collide or overwrite.",
  slug: "Carried, but resolved on import (`resolveUniqueSlug`) — a clone cannot take the original's slug.",
  workspace_id:
    "Tenancy. The import files the agent in the workspace the REQUEST is acting in, never the source's.",
  created_at:
    "When the SOURCE row was made. A restored agent is a new row, and its own timestamp is the true one.",
  updated_at: "As above.",
};

/**
 * Per-agent tables the bundle deliberately does not carry. Anything that is
 * runtime HISTORY, a CREDENTIAL, or a record made ABOUT a person rather than by
 * the agent's configuration.
 */
const TABLES_NOT_EXPORTED: Record<string, string> = {
  instances:
    "The agent row itself — it is the bundle's subject, not a section of it.",
  contact_optouts:
    "Consent given by a person to THIS deployment. Copying it would assert a consent nobody gave the copy.",
  knowledge_documents:
    "Content, not configuration, and possibly large — it has its own import route.",
  knowledge_chunks:
    "Derived from the documents above; recomputed by the embedder on the target.",
  memories:
    "What the agent learned from real conversations. A clone starts from the configuration, not the history.",
  conversations: "History.",
  conversation_state: "History.",
  principal_secrets:
    "Per-person OAuth tokens, encrypted and issued to THIS deployment.",
  ai_logs: "Runtime telemetry.",
  pipeline_traces: "Runtime telemetry.",
  tool_audit_logs: "Runtime audit.",
  hook_executions: "Runtime audit.",
  scheduled_task_runs: "Run history of the tasks the bundle does carry.",
  event_backlog: "Events still queued against the source deployment.",
  room_activity_log: "Runtime activity.",
  oauth_states: "A single-use nonce with a minutes-long TTL.",
  instance_tools:
    "Carried as `manualTools` — the auto-derived rows are recomputed from skills on import.",
};

/**
 * Which bundle field carries which table, and which of the table's columns it
 * deliberately leaves out. `field` is a path into the bundle schema: a nested
 * table names its parent section first (`eventSources.definitions`).
 *
 * The row's own identity — `id`, the agent key, the timestamps — is never
 * carried and is not repeated below; see {@link ROW_IDENTITY}.
 */
const BUNDLE_SECTIONS: Record<string, { field: string; notCarried?: Record<string, string> }> = {
  instance_prompts: { field: "prompts" },
  instance_skills: {
    field: "skills",
    notCarried: {
      skill_id:
        "A uuid of THIS deployment's catalog. Carried as `skillSlug` and resolved against the target's catalog.",
      skill_version_id: "As above, carried as `pinnedVersion`.",
    },
  },
  instance_skill_env: { field: "skillEnv" },
  instance_secrets: {
    field: "secrets",
    notCarried: {
      value:
        "Carried only for a key a tool or hook declares `sensitive: false`, as the optional `value`. A credential travels as its key, and the import asks for it.",
    },
  },
  instance_channels: { field: "channels" },
  instance_hooks: { field: "hooks" },
  instance_room: {
    field: "room",
    notCarried: {
      conversation_id: "The Room's running conversation on the source. The target opens its own.",
    },
  },
  instance_mcp_servers: { field: "mcpServers" },
  event_sources: {
    field: "eventSources",
    notCarried: {
      config: "The source's credentials. The import leaves it empty and the source disabled until configured.",
      webhook_token:
        "A bearer credential in the source's webhook URL, unique across the deployment. The target mints its own.",
    },
  },
  event_definitions: {
    field: "eventSources.definitions",
    notCarried: {
      event_source_id: "The parent row, which the nesting already expresses.",
    },
  },
  scheduled_tasks: {
    field: "scheduledTasks",
    notCarried: {
      next_run_at: "Recomputed from `schedule` on the target's clock.",
      last_run_at: "Run history.",
      last_run_status: "Run history.",
      last_error: "Run history.",
      last_conversation_id: "Run history, naming a conversation of the source.",
      consecutive_errors: "Run history.",
      total_runs: "Run history.",
    },
  },
};

/** Columns that identify a row rather than configure it, in every table. */
const ROW_IDENTITY = new Set(["id", "instance_id", "assistant_id", "created_at", "updated_at"]);

/** The object schema under a bundle field, through arrays, defaults and nullables. */
function objectAt(path: string): z.ZodObject<z.ZodRawShape> | undefined {
  let schema: z.ZodTypeAny = exportInstanceDataSchema;
  for (const key of path.split(".")) {
    const object = unwrap(schema);
    if (!object || !(key in object.shape)) return undefined;
    schema = object.shape[key];
  }
  return unwrap(schema);
}

function unwrap(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | undefined {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    if (current instanceof z.ZodObject) return current;
    if (current instanceof z.ZodArray) current = current.element;
    else if (
      current instanceof z.ZodDefault ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodOptional
    ) {
      current = current._def.innerType;
    } else return undefined;
  }
}

/** `thinking_level` → `thinkingLevel`. */
function camel(snake: string): string {
  return snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
}

describe("instance export coverage guardrail", () => {
  it("should_carry_or_explain_every_column_of_the_agent_row", () => {
    const fields = new Set(Object.keys(exportInstanceDataSchema.shape));
    const missing = getTableConfig(instances)
      .columns.map((c) => c.name)
      .filter((name) => !fields.has(camel(name)))
      .filter((name) => COLUMNS_NOT_EXPORTED[name] === undefined)
      .sort();

    // A column reaching here is per-agent configuration that export/import
    // silently drops. Add it to `export.schema.ts` and both import paths, or
    // record in `COLUMNS_NOT_EXPORTED` why a copy must not carry it.
    expect(missing).toEqual([]);
  });

  it("should_carry_or_explain_every_per_agent_table", async () => {
    const tables = [...(await perAgentTables()).keys()];

    // Non-vacuity first: an import shape that stops yielding tables would make
    // the check below pass over nothing.
    expect(tables.length).toBeGreaterThan(20);
    expect(tables).toContain("instance_prompts");
    expect(tables).toContain("event_definitions");

    const unexplained = tables
      .filter((name) => TABLES_NOT_EXPORTED[name] === undefined)
      .filter((name) => BUNDLE_SECTIONS[name] === undefined)
      .sort();

    expect(unexplained).toEqual([]);
  });

  it("should_carry_or_explain_every_column_of_every_carried_table", async () => {
    const tables = await perAgentTables();
    const missing: string[] = [];

    for (const [name, section] of Object.entries(BUNDLE_SECTIONS)) {
      const table = tables.get(name);
      const object = objectAt(section.field);
      if (!table || !object) continue; // reported by the two checks below
      const fields = new Set(Object.keys(object.shape));
      for (const column of getTableConfig(table).columns) {
        if (ROW_IDENTITY.has(column.name)) continue;
        if (section.notCarried?.[column.name] !== undefined) continue;
        if (!fields.has(camel(column.name))) missing.push(`${name}.${column.name}`);
      }
    }

    // A column reaching here is configuration the section drops: the row comes
    // back, without it. This is how a hook would return without the function it
    // runs. Carry it in the section's schema, its exporter and its importer, or
    // record in `notCarried` why a copy must not.
    expect(missing.sort()).toEqual([]);
  });

  it("should_not_explain_away_a_table_or_column_that_no_longer_exists", async () => {
    const tables = await perAgentTables();
    const stale = Object.keys(TABLES_NOT_EXPORTED).filter((name) => !tables.has(name));

    const agentColumns = new Set(getTableConfig(instances).columns.map((c) => c.name));
    stale.push(...Object.keys(COLUMNS_NOT_EXPORTED).filter((c) => !agentColumns.has(c)).map((c) => `instances.${c}`));

    for (const [name, section] of Object.entries(BUNDLE_SECTIONS)) {
      const table = tables.get(name);
      if (!table) {
        stale.push(name);
        continue;
      }
      const columns = new Set(getTableConfig(table).columns.map((c) => c.name));
      stale.push(...Object.keys(section.notCarried ?? {}).filter((c) => !columns.has(c)).map((c) => `${name}.${c}`));
    }

    expect(stale.sort()).toEqual([]);
  });

  it("should_map_every_declared_section_onto_a_real_bundle_field", () => {
    // The map above is the hand-written half of this file. If a section name
    // drifts from the schema, the checks above start vouching for a table with
    // nothing carrying it.
    const dangling = Object.entries(BUNDLE_SECTIONS)
      .filter(([, section]) => objectAt(section.field) === undefined)
      .map(([table, section]) => `${table} → ${section.field}`);

    expect(dangling).toEqual([]);
  });
});
