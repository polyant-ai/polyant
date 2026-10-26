// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import { db } from "../../database/client.js";
import { asRows } from "../../utils/query-helpers.js";
import { Permission } from "../../authz/permissions.js";
import { buildOrgScopedAgentFilterFragment } from "../../authz/scope-filter.js";
import { commonFilters, isUuid, likePattern, timeText } from "../monitor.sql.js";
import type { MonitorDetail, MonitorItem, MonitorSource, MonitorSourceQuery } from "../monitor.types.js";

/**
 * A conversation a webhook started (`conversations.source = 'webhook'`), read under
 * `conversation:read` like the conversation list. A conversation records no failure, so
 * its outcome is always `ok`; the conversation itself holds what the agent did.
 */

interface Row {
  id: string;
  instance_id: string;
  conversation_id: string;
  title: string | null;
  channel: string | null;
  message_count: number;
  ts: string;
}

const COLUMNS = sql`id, instance_id, conversation_id, title, channel, message_count`;

function toItem(r: Row): MonitorItem {
  return {
    id: r.id,
    type: "webhook",
    group: "automations",
    time: r.ts,
    agent: { slug: r.instance_id, name: r.instance_id },
    conversationId: r.conversation_id,
    summary: r.title ?? r.conversation_id,
    outcome: "ok",
    durationMs: null,
  };
}

export const webhookSource: MonitorSource = {
  type: "webhook",
  group: "automations",
  permission: Permission.CONVERSATION_READ,
  // A conversation is product data: the retention sweep does not age it out.
  retentionDays: () => null,

  async list(q: MonitorSourceQuery) {
    const filters = commonFilters(
      q,
      { time: "created_at", id: "id", agent: "instance_id" },
      (o) => (o === "ok" ? sql`true` : null),
    );
    const search = q.search
      ? sql`and (title ilike ${likePattern(q.search)} or conversation_id ilike ${likePattern(q.search)})`
      : sql``;
    const rows = asRows<Row>(
      await db.execute(sql`
        select ${COLUMNS}, ${timeText("created_at")} as ts
        from conversations
        where source = 'webhook' and created_at is not null ${filters} ${search}
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
        from conversations
        where id = ${id}::uuid and source = 'webhook' and created_at is not null
          ${buildOrgScopedAgentFilterFragment(scope, "instance_id")}
      `),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...toItem(r),
      error: null,
      sections: [
        ...(r.channel ? [{ key: "channel", kind: "text" as const, value: r.channel }] : []),
        { key: "messageCount", kind: "text", value: String(r.message_count) },
      ],
    };
  },
};
