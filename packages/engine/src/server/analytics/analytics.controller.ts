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
import { asInstanceSlug } from "../../instances/identifiers.js";
import { parseDateRange } from "../utils/parse-date-range.js";

@Controller("api")
export class AnalyticsController {
  // GET /api/analytics — global dashboard
  @Get("analytics")
  async global(
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const range = parseDateRange(from, to);
    const [analytics, latency] = await Promise.all([
      getAnalytics(range, undefined, true),
      getLatencyAnalytics(range),
    ]);
    return { ...analytics, latency };
  }

  // GET /api/instances/:slug/analytics — per-instance
  @Get("instances/:slug/analytics")
  async perInstance(
    @Param("slug") slug: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const instance = await findInstanceBySlug(asInstanceSlug(slug));
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);

    const range = parseDateRange(from, to);
    const [analytics, latency] = await Promise.all([
      getAnalytics(range, instance.slug),
      getLatencyAnalytics(range, instance.slug),
    ]);
    return { ...analytics, latency };
  }
}
