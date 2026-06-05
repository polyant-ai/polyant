// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Put, Delete, Param, Body, BadRequestException, NotFoundException } from "@nestjs/common";
import { getRoomBySlug, upsertRoom, deleteRoom } from "../../room/room.store.js";
import { countPendingEvents } from "../../webhooks/webhook-backlog.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

import { upsertRoomSchema } from "../../room/room.validators.js";

@Controller("api/instances/:slug/room")
export class RoomController {
  @Get()
  async getRoom(@Param("slug") slug: string) {
    const room = await getRoomBySlug(asInstanceSlug(slug));
    if (!room) return { configured: false };

    const pendingCount = await countPendingEvents(room.instanceId);
    return { configured: true, ...room, pendingEventCount: pendingCount };
  }

  @Put()
  async upsertRoomConfig(
    @Param("slug") slug: string,
    @Body() body: unknown,
  ) {
    const parsed = upsertRoomSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    await upsertRoom(instanceId, parsed.data);
    return { success: true };
  }

  @Delete()
  async deleteRoomConfig(@Param("slug") slug: string) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    await deleteRoom(instanceId);
    return { deleted: true };
  }
}
