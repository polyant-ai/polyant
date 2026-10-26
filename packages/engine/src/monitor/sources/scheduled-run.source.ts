// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "../../database/client.js";
import { asRows } from "../../utils/query-helpers.js";
import { Permission } from "../../authz/permissions.js";
import { buildOrgScopedAgentFilterFragment } from "../../authz/scope-filter.js";
import { commonFilters, isUuid, likePattern, timeText } from "../monitor.sql.js";
import type { MonitorDetail, MonitorItem, MonitorOutcome, MonitorSource, MonitorSourceQuery } from "../monitor.types.js";

/**
 * One run of a scheduled task (`scheduled_task_runs`), read under `agent.task:read` like
 * `/api/instances/:slug/scheduled-tasks/runs`. The task name is a correlated subquery so
 * the table keeps its bare `instance_id` column, which is what the tenant predicate names.
 */

interface Row {
  id: string;
  instance_id: string;
  conversation_id: string | null;
  status: string;
  trigger_type: string;
  duration_ms: number | null;
  error: string | null;
  output: string | null;
  tool_calls: unknown;
  task_name: string | null;
  ts: string;
}

const COLUMNS = sql`
  id, instance_id, conversation_id, status, trigger_type, duration_ms, error, output, tool_calls,
  (select t.name from scheduled_tasks t where t.id = scheduled_task_runs.task_id) as task_name`;

function outcomeOf(status: string): MonitorOutcome {
  if (status === "success") return "ok";
  if (status === "running") return "running";
  return "error";
}

function toItem(r: Row): MonitorItem {
  return {
    id: r.id,
    type: "scheduled_run",
    group: "automations",
    time: r.ts,
    agent: { slug: r.instance_id, name: r.instance_id },
    conversationId: r.conversation_id,
    summary: r.task_name ?? r.id,
    outcome: outcomeOf(r.status),
    durationMs: r.duration_ms,
  };
}

export const scheduledRunSource: MonitorSource = {
  type: "scheduled_run",
  group: "automations",
  permission: Permission.TASK_READ,
  retentionDays: (telemetry) => telemetry,

  async list(q: MonitorSourceQuery) {
    const filters = commonFilters(
      q,
      { time: "started_at", id: "id", agent: "instance_id" },
      (o) =>
        o === "ok" ? sql`status = 'success'` : o === "running" ? sql`status = 'running'` : o === "error" ? sql`status = 'error'` : null,
    );
    const search = q.search
      ? sql`and ((select t.name from scheduled_tasks t where t.id = scheduled_task_runs.task_id) ilike ${likePattern(q.search)} or error ilike ${likePattern(q.search)})`
      : sql``;
    const rows = asRows<Row>(
      await db.execute(sql`
        select ${COLUMNS}, ${timeText("started_at")} as ts
        from scheduled_task_runs
        where true ${filters} ${search}
        order by started_at desc, id desc
        limit ${q.limit}
      `),
    );
    return rows.map(toItem);
  },

  async detail(id, scope): Promise<MonitorDetail | null> {
    if (!isUuid(id)) return null;
    const rows = asRows<Row>(
      await db.execute(sql`
        select ${COLUMNS}, ${timeText("started_at")} as ts
        from scheduled_task_runs
        where id = ${id}::uuid ${buildOrgScopedAgentFilterFragment(scope, "instance_id")}
      `),
    );
    const r = rows[0];
    if (!r) return null;
    const toolCalls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
    return {
      ...toItem(r),
      error: r.error,
      sections: [
        { key: "trigger", kind: "text", value: r.trigger_type },
        ...(r.output ? [{ key: "output", kind: "text" as const, value: r.output }] : []),
        ...(toolCalls.length > 0 ? [{ key: "toolCalls", kind: "json" as const, value: toolCalls }] : []),
      ],
    };
  },
};
