// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for migration 0075 (instance -> agent DB-name rename).
 * Asserts the renamed tables and columns against a migrated Postgres, so a
 * partially-applied rename (a table missed from the migration list) fails loudly
 * instead of surfacing as "zero rows" at runtime.
 *
 * Self-skips when no migrated database is reachable (so a bare `npm test`
 * without a DB stays green). Run it for real with a database up:
 *   docker compose up -d postgres && npm run db:migrate && npm run test:integration
 */

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db, queryClient } from "./client.js";

async function dbReachable(): Promise<boolean> {
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("db probe timeout")), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const DB_AVAILABLE = await dbReachable();

/** The 9 tables the migration renames wholesale. */
const RENAMED_TABLES = [
  "agents",
  "agent_prompts",
  "agent_skills",
  "agent_tools",
  "agent_secrets",
  "agent_channels",
  "agent_skill_env",
  "agent_room",
  "agent_hooks",
  "agent_mcp_servers",
] as const;

/** Every table that must carry an `agent_id` column after the migration. */
const AGENT_ID_TABLES = [
  ...RENAMED_TABLES.filter((t) => t !== "agents"),
  "conversations",
  "conversation_state",
  "memories",
  "pipeline_traces",
  "tool_audit_logs",
  "ai_logs",
  "knowledge_documents",
  "knowledge_chunks",
  "scheduled_tasks",
  "scheduled_task_runs",
  "event_sources",
  "event_backlog",
  "room_activity_log",
  "contact_optouts",
  "hook_executions",
  "principal_secrets",
  "oauth_states",
] as const;

async function publicTables(): Promise<Set<string>> {
  const rows = await queryClient<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  return new Set(rows.map((r) => r.table_name));
}

async function columnsNamed(column: string): Promise<Set<string>> {
  const rows = await queryClient<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = ${column}`;
  return new Set(rows.map((r) => r.table_name));
}

describe.skipIf(!DB_AVAILABLE)("0075 instance -> agent rename", () => {
  it("renames every instance_* table to agent_* and leaves no instance_* table behind", async () => {
    const tables = await publicTables();

    for (const table of RENAMED_TABLES) {
      expect(tables, `expected table ${table}`).toContain(table);
    }

    const leftovers = [...tables].filter((t) => t.startsWith("instance"));
    expect(leftovers).toEqual([]);
  });

  it("renames instance_id to agent_id on every tenant-scoped table", async () => {
    const withAgentId = await columnsNamed("agent_id");

    for (const table of AGENT_ID_TABLES) {
      expect(withAgentId, `expected ${table}.agent_id`).toContain(table);
    }
  });

  it("leaves no instance_id column on any renamed table", async () => {
    const withInstanceId = await columnsNamed("instance_id");
    expect([...withInstanceId]).toEqual([]);
  });

  it("keeps agent slug values readable through the renamed table", async () => {
    const rows = await queryClient<{ slug: string }[]>`
      SELECT slug FROM agents ORDER BY slug LIMIT 1`;
    // A migrated DB may legitimately hold zero agents; the point is the column
    // resolves at all, which a failed rename would break.
    expect(Array.isArray(rows)).toBe(true);
  });
});
