// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "../../database/client.js";
import { asRows } from "../../utils/query-helpers.js";
import { Permission } from "../../authz/permissions.js";
import { buildOrgScopedAgentFilterFragment } from "../../authz/scope-filter.js";
import { commonFilters, isUuid, likePattern, timeText } from "../monitor.sql.js";
import type { MonitorDetail, MonitorItem, MonitorSource, MonitorSourceQuery } from "../monitor.types.js";

/** One audited tool call (`tool_audit_logs`), read under `audit_log:read` like `/api/audit-logs`. */

interface Row {
  id: string;
  instance_id: string;
  conversation_id: string | null;
  tool_name: string;
  action: string;
  success: boolean;
  duration_ms: number | null;
  error: string | null;
  details: Record<string, unknown> | null;
  output: string | null;
  ts: string;
}

const COLUMNS = sql`id, instance_id, conversation_id, tool_name, action, success, duration_ms, error, details, output`;

function toItem(r: Row): MonitorItem {
  return {
    id: r.id,
    type: "tool_call",
    group: "agents",
    time: r.ts,
    agent: { slug: r.instance_id, name: r.instance_id },
    conversationId: r.conversation_id,
    summary: `${r.tool_name}: ${r.action}`,
    outcome: r.success ? "ok" : "error",
    durationMs: r.duration_ms,
  };
}

export const toolCallSource: MonitorSource = {
  type: "tool_call",
  group: "agents",
  permission: Permission.AUDIT_LOG_READ,
  retentionDays: (telemetry) => telemetry,

  async list(q: MonitorSourceQuery) {
    const filters = commonFilters(
      q,
      { time: "created_at", id: "id", agent: "instance_id" },
      (o) => (o === "ok" ? sql`success` : o === "error" ? sql`not success` : null),
    );
    const search = q.search
      ? sql`and (tool_name ilike ${likePattern(q.search)} or action ilike ${likePattern(q.search)} or error ilike ${likePattern(q.search)})`
      : sql``;
    const rows = asRows<Row>(
      await db.execute(sql`
        select ${COLUMNS}, ${timeText("created_at")} as ts
        from tool_audit_logs
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
        from tool_audit_logs
        where id = ${id}::uuid ${buildOrgScopedAgentFilterFragment(scope, "instance_id")}
      `),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...toItem(r),
      error: r.error,
      sections: [
        { key: "arguments", kind: "json", value: r.details ?? {} },
        ...(r.output ? [{ key: "output", kind: "text" as const, value: r.output }] : []),
      ],
    };
  },
};
