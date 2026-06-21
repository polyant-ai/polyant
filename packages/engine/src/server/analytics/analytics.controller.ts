// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
} from "@nestjs/common";
import { getAnalytics } from "../../analytics/analytics.store.js";
import { getLatencyAnalytics } from "../../analytics/latency.store.js";
import { findInstanceBySlug } from "../../instances/store.js";
import { asAgentSlug } from "../../instances/identifiers.js";
import { parseDateRange } from "../utils/parse-date-range.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { RequirePermission, Permission } from "../../authz/index.js";

@Controller("api")
export class AnalyticsController {
  // GET /api/analytics — global dashboard
  @RequirePermission(Permission.ANALYTICS_READ)
  @Get("analytics")
  async global(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const range = parseDateRange(from, to);
    const orgId = user?.orgId;
    const [analytics, latency] = await Promise.all([
      getAnalytics(range, undefined, true, orgId),
      getLatencyAnalytics(range, undefined, orgId),
    ]);
    return { ...analytics, latency };
  }

  // GET /api/agents/:slug/analytics — per-instance
  @RequirePermission(Permission.ANALYTICS_READ)
  @Get("instances/:slug/analytics")
  async perInstance(
    @Param("slug") slug: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const instance = await findInstanceBySlug(asAgentSlug(slug));
    if (!instance) throw new NotFoundException(`Agent "${slug}" not found`);

    const range = parseDateRange(from, to);
    const orgId = user?.orgId;
    // orgId is ANDed in the store: a foreign-org slug yields empty analytics
    // (param-IDOR closed at the store layer, not by an extra ownership check).
    const [analytics, latency] = await Promise.all([
      getAnalytics(range, instance.slug, false, orgId),
      getLatencyAnalytics(range, instance.slug, orgId),
    ]);
    return { ...analytics, latency };
  }
}
