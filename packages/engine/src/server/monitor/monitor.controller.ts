// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { AuthenticatedOnly } from "../../authz/index.js";
import { AuthorizationService } from "../../authz/authorization.service.js";
import type { PermissionKey } from "../../authz/permissions.js";
import type { TenantScope } from "../../authz/scope-filter.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { resolvePlatformSettings } from "../../platform/platform-settings.store.js";
import { callerTenantScope } from "../utils/caller-tenant-scope.js";
import {
  MONITOR_OUTCOMES,
  decodeCursor,
  readMonitor,
  readMonitorDetail,
  type CanRead,
  type MonitorOutcome,
} from "../../monitor/index.js";
import { parsePagination } from "../utils/parse-pagination.js";

const MAX_SEARCH_LENGTH = 200;

function singleString(name: string, value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequestException(`"${name}" must be a string`);
  return value;
}

/** `?types=a,b`, `?types=a&types=b` and `?types[]=a` all arrive here as a string or an array. */
function stringList(name: string, value: unknown): string[] {
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : [value];
  if (parts.some((p) => typeof p !== "string")) throw new BadRequestException(`"${name}" must be strings`);
  return (parts as string[]).flatMap((p) => p.split(",")).map((p) => p.trim()).filter(Boolean);
}

function parseInstant(name: string, value: unknown): Date | undefined {
  const text = singleString(name, value);
  if (!text) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`"${name}" must be an ISO 8601 date`);
  return date;
}

/**
 * The Monitor: one timeline of what happened, read from the tables that record it.
 *
 * Authorization is per item type rather than per route, so a caller is never refused the
 * whole list because one type is closed to them: each type is read under the permission
 * that guards the same rows on their own pages, and a type the caller cannot read is
 * left out. The route therefore declares `@AuthenticatedOnly()` (a human session; no
 * service principal) and decides each permission itself, with the same standing the
 * `PermissionGuard` gives a platform administrator.
 */
@Controller("api/monitor")
export class MonitorController {
  constructor(@Inject(AuthorizationService) private readonly authz: AuthorizationService) {}

  @AuthenticatedOnly()
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("types") types?: unknown,
    @Query("group") group?: unknown,
    @Query("agent") agent?: unknown,
    @Query("outcome") outcome?: unknown,
    @Query("from") from?: unknown,
    @Query("to") to?: unknown,
    @Query("q") q?: unknown,
    @Query("cursor") cursor?: unknown,
    @Query("limit") limit?: unknown,
  ) {
    const outcomeText = singleString("outcome", outcome);
    if (outcomeText && !MONITOR_OUTCOMES.includes(outcomeText as MonitorOutcome)) {
      throw new BadRequestException(`"outcome" must be one of ${MONITOR_OUTCOMES.join(", ")}`);
    }
    const cursorText = singleString("cursor", cursor);
    const decoded = cursorText ? decodeCursor(cursorText) : undefined;
    if (cursorText && !decoded) throw new BadRequestException('"cursor" is not valid');
    const search = singleString("q", q);
    if (search && search.length > MAX_SEARCH_LENGTH) {
      throw new BadRequestException(`"q" must be at most ${MAX_SEARCH_LENGTH} characters`);
    }
    const fromDate = parseInstant("from", from);
    const toDate = parseInstant("to", to);
    if (fromDate && toDate && fromDate > toDate) throw new BadRequestException('"from" must be before "to"');

    const scope = await callerTenantScope(user);
    const { analyticsRetentionDays } = await resolvePlatformSettings();

    return readMonitor({
      scope,
      canRead: await this.canRead(user, scope),
      types: stringList("types", types),
      group: singleString("group", group),
      agent: singleString("agent", agent),
      outcome: outcomeText as MonitorOutcome | undefined,
      from: fromDate,
      to: toDate,
      search,
      cursor: decoded,
      limit: parsePagination(singleString("limit", limit), undefined, { defaultLimit: 50, maxLimit: 100 }).limit,
      telemetryRetentionDays: analyticsRetentionDays,
    });
  }

  @AuthenticatedOnly()
  @Get(":type/:id")
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("type") type: string,
    @Param("id") id: string,
  ) {
    const scope = await callerTenantScope(user);
    // The same answer for a missing row, a foreign one and a type the caller cannot read.
    const detail = await readMonitorDetail(type, id, scope, await this.canRead(user, scope));
    if (!detail) throw new NotFoundException("Monitor item not found");
    return detail;
  }

  private async canRead(user: AuthenticatedUser, scope: TenantScope): Promise<CanRead> {
    const organizationId = "organizationId" in scope ? scope.organizationId : "";
    const platformAdmin = await this.authz.isPlatformAdmin(user.userId);
    return async (permission: PermissionKey) =>
      platformAdmin || (await this.authz.can(user.userId, { agentId: "", workspaceId: "", organizationId }, permission));
  }
}
