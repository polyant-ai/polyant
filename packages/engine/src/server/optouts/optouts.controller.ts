// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { findInstanceBySlug } from "../../instances/store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { listOptouts, setOptoutStatus, type OptoutStatus } from "../../optout/index.js";
import { RequirePermission, Permission } from "../../authz/index.js";

/**
 * Admin management of opt-out contacts. All operations are instance-scoped:
 * the slug is resolved to a uuid and every query is constrained by it (IDOR-safe).
 */
@Controller("api/instances/:slug/optouts")
export class OptoutsController {
  // GET — paginated list (default: currently opted-out contacts)
  @RequirePermission(Permission.GOVERNANCE_READ)
  @Get()
  async list(
    @Param("slug") slug: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
  ) {
    const instance = await this.resolve(slug);
    const limit = 50;
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const effectiveStatus: OptoutStatus | undefined =
      status === "opted_in" ? "opted_in" : status === "all" ? undefined : "opted_out";
    const optouts = await listOptouts(instance.id, {
      status: effectiveStatus,
      limit,
      offset: (pageNum - 1) * limit,
    });
    return { optouts, page: pageNum };
  }

  // POST — manually opt a contact OUT (admin override)
  @RequirePermission(Permission.GOVERNANCE_WRITE)
  @Post()
  async optOut(
    @Param("slug") slug: string,
    @Body() body: { channelType?: string; channelId?: string },
  ) {
    const instance = await this.resolve(slug);
    const { channelType, channelId } = this.validateContact(body);
    await setOptoutStatus({
      instanceId: instance.id,
      instanceSlug: instance.slug,
      channelType,
      channelId,
      status: "opted_out",
      source: "admin",
    });
    return { ok: true };
  }

  // DELETE — manually opt a contact back IN (admin override)
  @RequirePermission(Permission.GOVERNANCE_WRITE)
  @Delete(":channelType/:channelId")
  async optIn(
    @Param("slug") slug: string,
    @Param("channelType") channelType: string,
    @Param("channelId") channelId: string,
  ) {
    const instance = await this.resolve(slug);
    await setOptoutStatus({
      instanceId: instance.id,
      instanceSlug: instance.slug,
      channelType,
      channelId,
      status: "opted_in",
      source: "admin",
    });
    return { ok: true };
  }

  private async resolve(slug: string) {
    const instance = await findInstanceBySlug(asInstanceSlug(slug));
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    return instance;
  }

  private validateContact(body: { channelType?: string; channelId?: string }): {
    channelType: string;
    channelId: string;
  } {
    const channelType = body.channelType?.trim();
    const channelId = body.channelId?.trim();
    if (!channelType || !channelId) {
      throw new BadRequestException("channelType and channelId are required");
    }
    return { channelType, channelId };
  }
}
