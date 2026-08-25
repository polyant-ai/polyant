// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Post, Put, Delete, Param, Body, Header, BadRequestException, NotFoundException } from "@nestjs/common";
import {
  listEventSourcesWithDefinitions, createEventSource, updateEventSource, deleteEventSource,
  rotateWebhookToken, getEventSourceWebhookToken, listDefinitions, createDefinition, updateDefinition, deleteDefinition,
} from "../../webhooks/webhook-sources.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { maskSensitiveConfig } from "../instances/instance-helpers.js";
import {
  createEventSourceSchema, updateEventSourceSchema,
  createDefinitionSchema, updateDefinitionSchema,
} from "../../webhooks/webhook.validators.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { buildEventSourceWebhookUrl as buildWebhookUrl } from "../webhook-url.js";

@Controller("api/instances/:slug/event-sources")
export class EventSourcesController {
  /**
   * The webhook token/URL is bearer-equivalent — its holder can inject
   * arbitrary events into the agent — so a ROOM_READ caller must not see it,
   * mirroring the WhatsApp channel's apiKey `webhookSecret`, which is
   * likewise withheld from CHANNEL_READ. Reveal lives at the dedicated
   * ROOM_WRITE endpoint below.
   */
  @RequirePermission(Permission.ROOM_READ)
  @Get()
  async list(@Param("slug") slug: string) {
    const sources = await listEventSourcesWithDefinitions(asInstanceSlug(slug));
    // Explicit DTO, not a spread of the store row: `webhookToken` must never
    // reach a ROOM_READ caller, and listing every field here is what keeps a
    // future store column from leaking into the response by accident.
    return sources.map((s) => ({
      id: s.id,
      instanceId: s.instanceId,
      name: s.name,
      sourceType: s.sourceType,
      enabled: s.enabled,
      createdAt: s.createdAt,
      config: maskSensitiveConfig(s.config),
      definitions: s.definitions,
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

  /**
   * Reveal the ingestion URL for one source. Gated on ROOM_WRITE, not
   * ROOM_READ: the token it embeds is bearer-equivalent, so a read-only role
   * must not be able to obtain it and start injecting events. `no-store`
   * because the response carries that bearer-equivalent token — same reason
   * as the WhatsApp channel's `GET .../webhook-url` route.
   */
  @RequirePermission(Permission.ROOM_WRITE)
  @Header("Cache-Control", "no-store")
  @Get(":id/webhook-url")
  async webhookUrl(
    @Param("slug") slug: string,
    @Param("id") id: string,
  ) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const token = await getEventSourceWebhookToken(id, instanceId);
    if (!token) throw new NotFoundException("Event source not found");

    return { webhookUrl: buildWebhookUrl(token) };
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
