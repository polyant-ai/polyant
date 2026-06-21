// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Post, Put, Delete, Param, Body, BadRequestException, NotFoundException } from "@nestjs/common";
import {
  listEventSourcesWithDefinitions, createEventSource, updateEventSource, deleteEventSource,
  rotateWebhookToken, listDefinitions, createDefinition, updateDefinition, deleteDefinition,
} from "../../webhooks/webhook-sources.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { config } from "../../config.js";
import {
  createEventSourceSchema, updateEventSourceSchema,
  createDefinitionSchema, updateDefinitionSchema,
} from "../../webhooks/webhook.validators.js";
import { RequirePermission, Permission } from "../../authz/index.js";

function buildWebhookUrl(token: string): string {
  const base = config.server.baseUrl ?? `http://localhost:${config.server.port}`;
  return `${base}/webhooks/${token}`;
}

@Controller("api/instances/:slug/event-sources")
export class EventSourcesController {
  @RequirePermission(Permission.ROOM_READ)
  @Get()
  async list(@Param("slug") slug: string) {
    const sources = await listEventSourcesWithDefinitions(asInstanceSlug(slug));
    return sources.map((s) => ({
      ...s,
      config: Object.fromEntries(
        Object.entries(s.config).map(([k, v]) => [k, typeof v === "string" && v.length > 4 ? `••••${v.slice(-4)}` : v]),
      ),
      webhookUrl: buildWebhookUrl(s.webhookToken),
    }));
  }

  @RequirePermission(Permission.ROOM_WRITE)
  @Post()
  async create(
    @Param("slug") slug: string,
    @Body() body: unknown,
  ) {
    const parsed = createEventSourceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const result = await createEventSource(instanceId, parsed.data);
    return {
      ...result,
      webhookUrl: buildWebhookUrl(result.webhookToken),
    };
  }

  @RequirePermission(Permission.ROOM_WRITE)
  @Put(":id")
  async update(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateEventSourceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    // Strip masked values to prevent overwriting real secrets with mask placeholders
    const data = { ...parsed.data };
    if (data.config) {
      const cleaned = Object.fromEntries(
        Object.entries(data.config).filter(([, v]) => typeof v !== "string" || !v.startsWith("••••")),
      );
      data.config = Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }

    await updateEventSource(id, instanceId, data);
    return { success: true };
  }

  @RequirePermission(Permission.ROOM_WRITE)
  @Delete(":id")
  async remove(
    @Param("slug") slug: string,
    @Param("id") id: string,
  ) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    await deleteEventSource(id, instanceId);
    return { deleted: true };
  }

  @RequirePermission(Permission.ROOM_WRITE)
  @Post(":id/rotate-token")
  async rotate(
    @Param("slug") slug: string,
    @Param("id") id: string,
  ) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const newToken = await rotateWebhookToken(id, instanceId);
    return {
      webhookToken: newToken,
      webhookUrl: buildWebhookUrl(newToken),
    };
  }

  @RequirePermission(Permission.ROOM_READ)
  @Get(":id/definitions")
  async listDefs(
    @Param("slug") slug: string,
    @Param("id") id: string,
  ) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    return listDefinitions(id, instanceId);
  }

  @RequirePermission(Permission.ROOM_WRITE)
  @Post(":id/definitions")
  async createDef(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = createDefinitionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    return createDefinition(id, instanceId, parsed.data);
  }

  @RequirePermission(Permission.ROOM_WRITE)
  @Put(":id/definitions/:defId")
  async updateDef(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Param("defId") defId: string,
    @Body() body: unknown,
  ) {
    const parsed = updateDefinitionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    await updateDefinition(defId, id, instanceId, parsed.data);
    return { success: true };
  }

  @RequirePermission(Permission.ROOM_WRITE)
  @Delete(":id/definitions/:defId")
  async removeDef(
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Param("defId") defId: string,
  ) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    await deleteDefinition(defId, id, instanceId);
    return { deleted: true };
  }
}
