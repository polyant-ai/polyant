// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Query } from "@nestjs/common";
import { listAuditLogs, getAuditStats } from "../../audit/index.js";
import { parseDateRange } from "../utils/parse-date-range.js";
import { parsePagination } from "../utils/parse-pagination.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";

// `instanceId` stays OPTIONAL here (unlike /memories and /api/conversations/:id
// which require it): audit logs are an "all agents" view. Cross-org isolation is
// now enforced at the STORE layer via the caller's `orgId` (RBAC Stream 2) — an
// aggregate list returns only caller-org rows and a foreign-org instanceId param
// yields zero rows — so the controller never needs to require instanceId.

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
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const range = parseDateRange(from, to);
    const { limit, offset } = parsePagination(limitStr, offsetStr);

    return listAuditLogs({
      instanceId: instanceId ? asInstanceSlug(instanceId) : undefined,
      toolName,
      action,
      search,
      from: from ? range.from : undefined,
      to: to ? range.to : undefined,
      limit,
      offset,
      orgId: user?.orgId,
    });
  }

  @Get("stats")
  async stats(
    @Query("instanceId") instanceId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const range = parseDateRange(from, to);
    return getAuditStats({
      instanceId: instanceId ? asInstanceSlug(instanceId) : undefined,
      from: from ? range.from : undefined,
      to: to ? range.to : undefined,
      orgId: user?.orgId,
    });
  }
}
