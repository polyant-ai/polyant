// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
} from "@nestjs/common";
import type { Response } from "express";
import { getAnalytics } from "../../analytics/analytics.store.js";
import { getLatencyAnalytics } from "../../analytics/latency.store.js";
import { findInstanceBySlug, resolvePrincipalOrgId } from "../../instances/store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { parseDateRange } from "../utils/parse-date-range.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { RequirePermission, Permission } from "../../authz/index.js";

/**
 * A SHORT, PRIVATE cache on both analytics routes.
 *
 * `AnalyticsDashboard` is the organization landing page — the first thing every
 * user sees on login and on every org switch — and it fires sixteen uncached
 * aggregate scans, four of which count every message ever (the LATERAL subquery
 * carries no date predicate of its own) and two of which unnest jsonb per
 * message. There is no rollup table and no client-side cache, so it was a full
 * recomputation on every mount.
 *
 * `private` is not optional: this is tenant-scoped data and must never be held
 * by a shared proxy. 30s is chosen to absorb a reload and a back-navigation
 * without making the dashboard feel stale.
 */
const ANALYTICS_CACHE_CONTROL = "private, max-age=30";

@Controller("api")
export class AnalyticsController {
  // GET /api/analytics — global dashboard
  @RequirePermission(Permission.ANALYTICS_READ)
  @Get("analytics")
  async global(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @CurrentUser() user?: AuthenticatedUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const range = parseDateRange(from, to);
    const orgId = (await resolvePrincipalOrgId(user?.orgId)) ?? undefined;
    const [analytics, latency] = await Promise.all([
      getAnalytics(range, undefined, true, orgId),
      getLatencyAnalytics(range, undefined, orgId),
    ]);
    res?.setHeader("Cache-Control", ANALYTICS_CACHE_CONTROL);
    return { ...analytics, latency };
  }

  // GET /api/instances/:slug/analytics — per-instance
  @RequirePermission(Permission.ANALYTICS_READ)
  @Get("instances/:slug/analytics")
  async perInstance(
    @Param("slug") slug: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @CurrentUser() user?: AuthenticatedUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const instance = await findInstanceBySlug(asInstanceSlug(slug));
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);

    const range = parseDateRange(from, to);
    const orgId = (await resolvePrincipalOrgId(user?.orgId)) ?? undefined;
    // orgId is ANDed in the store: a foreign-org slug yields empty analytics
    // (param-IDOR closed at the store layer, not by an extra ownership check).
    const [analytics, latency] = await Promise.all([
      getAnalytics(range, instance.slug, false, orgId),
      getLatencyAnalytics(range, instance.slug, orgId),
    ]);
    res?.setHeader("Cache-Control", ANALYTICS_CACHE_CONTROL);
    return { ...analytics, latency };
  }
}
