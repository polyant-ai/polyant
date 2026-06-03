// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Query } from "@nestjs/common";
import { listAuditLogs, getAuditStats } from "../../audit/index.js";
import { parseDateRange } from "../utils/parse-date-range.js";
import { parsePagination } from "../utils/parse-pagination.js";

// NOTE: `instanceId` is OPTIONAL here (unlike /memories and /api/conversations/:id
// which need it as an IDOR scope). Audit logs are a system-wide view: a logged-in
// user is allowed to see tool executions across every instance, and the admin
// panel's "all agents" selector relies on that. The store
// (`audit-query.store.ts:instanceFilter`) already accepts `undefined` and emits
// an empty SQL filter. When polyant grows real multi-tenancy
// (org > project > instance, CLAUDE.md "Auth & Multi-Tenancy" Phase 2),
// isolation will be enforced at the `org` layer — not by requiring instanceId here.

@Controller("api/audit-logs")
export class AuditController {
  @Get()
  async list(
    @Query("instanceId") instanceId?: string,
    @Query("toolName") toolName?: string,
    @Query("action") action?: string,
    @Query("search") search?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
  ) {
    const range = parseDateRange(from, to);
    const { limit, offset } = parsePagination(limitStr, offsetStr);

    return listAuditLogs({
      instanceId,
      toolName,
      action,
      search,
      from: from ? range.from : undefined,
      to: to ? range.to : undefined,
      limit,
      offset,
    });
  }

  @Get("stats")
  async stats(
    @Query("instanceId") instanceId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const range = parseDateRange(from, to);
    return getAuditStats({
      instanceId,
      from: from ? range.from : undefined,
      to: to ? range.to : undefined,
    });
  }
}
