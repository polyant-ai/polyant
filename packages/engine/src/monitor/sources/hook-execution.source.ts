// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "../../database/client.js";
import { asRows } from "../../utils/query-helpers.js";
import { Permission } from "../../authz/permissions.js";
import { buildOrgScopedAgentFilterFragment } from "../../authz/scope-filter.js";
import { commonFilters, isUuid, likePattern, timeText } from "../monitor.sql.js";
import type { MonitorDetail, MonitorItem, MonitorSource, MonitorSourceQuery } from "../monitor.types.js";

/**
 * One firing of a lifecycle hook (`hook_executions`). Hooks showed only inside the
 * transcript of the conversation that fired them, so they are read under
 * `conversation:read`, the permission that opens that transcript.
 */

interface Row {
  id: string;
  instance_id: string;
  conversation_id: string;
  event: string;
  tool_name: string;
  success: boolean;
  duration_ms: number;
  error: string | null;
  args: Record<string, unknown> | null;
  result: string | null;
  ts: string;
}

const COLUMNS = sql`id, instance_id, conversation_id, event, tool_name, success, duration_ms, error, args, result`;

function toItem(r: Row): MonitorItem {
  return {
    id: r.id,
    type: "hook",
    group: "agents",
    time: r.ts,
    agent: { slug: r.instance_id, name: r.instance_id },
    conversationId: r.conversation_id,
    summary: `${r.event}: ${r.tool_name}`,
    outcome: r.success ? "ok" : "error",
    durationMs: r.duration_ms,
  };
}

export const hookExecutionSource: MonitorSource = {
  type: "hook",
  group: "agents",
  permission: Permission.CONVERSATION_READ,
  retentionDays: (telemetry) => telemetry,

  async list(q: MonitorSourceQuery) {
    const filters = commonFilters(
      q,
      { time: "created_at", id: "id", agent: "instance_id" },
      (o) => (o === "ok" ? sql`success` : o === "error" ? sql`not success` : null),
    );
    const search = q.search
      ? sql`and (tool_name ilike ${likePattern(q.search)} or event ilike ${likePattern(q.search)} or error ilike ${likePattern(q.search)})`
      : sql``;
    const rows = asRows<Row>(
      await db.execute(sql`
        select ${COLUMNS}, ${timeText("created_at")} as ts
        from hook_executions
        where true ${filters} ${search}
        order by created_at desc, id desc
        limit ${q.limit}
      `),
    );
    return rows.map(toItem);
  },

  async detail(id, scope): Promise<MonitorDetail | null> {
    if (!isUuid(id)) return null;
    const rows = asRows<Row>(
      await db.execute(sql`
        select ${COLUMNS}, ${timeText("created_at")} as ts
        from hook_executions
        where id = ${id}::uuid ${buildOrgScopedAgentFilterFragment(scope, "instance_id")}
      `),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...toItem(r),
      error: r.error,
      sections: [
        ...(r.args ? [{ key: "arguments", kind: "json" as const, value: r.args }] : []),
        ...(r.result ? [{ key: "output", kind: "text" as const, value: r.result }] : []),
      ],
    };
  },
};
