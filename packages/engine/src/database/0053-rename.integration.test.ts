// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { queryClient } from "./client.js";

/**
 * Migration 0053 renames the core domain entity instance → agent at the DB-name
 * layer: 9 instance_* tables become agent_*, and the instance_id column becomes
 * agent_id across all tenant-scoped tables. Slug *values* are untouched.
 */
describe("0053 instance→agent rename", () => {
  it("renames the agents table and removes the legacy instances table", async () => {
    const rows = await queryClient`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('agents', 'instances')`;
    const names = rows.map((r) => r.table_name);
    expect(names).toContain("agents");
    expect(names).not.toContain("instances");
  });

  it("renames all instance_* child tables to agent_*", async () => {
    const rows = await queryClient`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'instance_%'`;
    expect(rows.map((r) => r.table_name)).toEqual([]);

    const expected = [
      "agent_channels",
      "agent_hooks",
      "agent_prompts",
      "agent_room",
      "agent_secrets",
      "agent_skill_env",
      "agent_skills",
      "agent_tools",
    ];
    const agentTables = await queryClient`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${expected})`;
    expect(agentTables.map((r) => r.table_name).sort()).toEqual(expected);
  });

  it("renames instance_id to agent_id on every tenant-scoped table", async () => {
    const leftover = await queryClient`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'instance_id'`;
    expect(leftover.map((r) => r.table_name)).toEqual([]);
  });

  it("keeps agent_id on conversations, conversation_state, memories and other slug tables", async () => {
    for (const table of [
      "conversations",
      "conversation_state",
      "memories",
      "pipeline_traces",
      "ai_logs",
      "hook_executions",
    ]) {
      const rows = await queryClient`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = ${table} AND column_name IN ('instance_id', 'agent_id')`;
      const cols = rows.map((r) => r.column_name);
      expect(cols, `${table} should expose agent_id`).toContain("agent_id");
      expect(cols, `${table} should not expose instance_id`).not.toContain(
        "instance_id",
      );
    }
  });
});
