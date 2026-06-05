// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Query, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { listBacklog, BACKLOG_STATUS } from "../../webhooks/webhook-backlog.store.js";
import { listActivity } from "../../room/activity-log.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const backlogStatusValues = Object.values(BACKLOG_STATUS) as [string, ...string[]];
const backlogQuerySchema = paginationSchema.extend({
  status: z.enum(backlogStatusValues).optional(),
});

const activityLogTypes = ["daily", "weekly", "monthly"] as const;
const activityQuerySchema = paginationSchema.extend({
  logType: z.enum(activityLogTypes).optional(),
});

@Controller("api/instances/:slug/room")
export class WebhookBacklogController {
  @Get("backlog")
  async getBacklog(
    @Param("slug") slug: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const parsed = backlogQuerySchema.safeParse({ status, limit, offset });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) return { events: [], total: 0 };

    return listBacklog(instanceId, {
      status: parsed.data.status,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  }

  @Get("activity")
  async getActivity(
    @Param("slug") slug: string,
    @Query("logType") logType?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const parsed = activityQuerySchema.safeParse({ logType, limit, offset });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) return [];

    return listActivity(instanceId, {
      logType: parsed.data.logType,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  }
}
