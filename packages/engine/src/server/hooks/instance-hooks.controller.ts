// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import {
  listHooks,
  createHook,
  updateHook,
  deleteHook,
  invalidateHooksCache,
} from "../../hooks/hooks.store.js";
import {
  createHookSchema,
  updateHookSchema,
  validateHookTool,
} from "../../hooks/hooks.validators.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api/instances/:slug/hooks")
export class InstanceHooksController {
  @Get()
  async list(@Param("slug") slug: string) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");
    return { hooks: await listHooks(instanceId) };
  }

  @Post()
  async create(@Param("slug") slug: string, @Body() body: unknown) {
    const parsed = createHookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }
    const toolError = validateHookTool(parsed.data.actionConfig.toolName);
    if (toolError) throw new BadRequestException(toolError);

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const hook = await createHook(instanceId, parsed.data);
    invalidateHooksCache(asInstanceSlug(slug));
    return { hook };
  }

  @Patch(":id")
  async update(@Param("slug") slug: string, @Param("id") id: string, @Body() body: unknown) {
    if (!UUID_RE.test(id)) throw new BadRequestException("Invalid hook id");
    const parsed = updateHookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }
    if (parsed.data.actionConfig) {
      const toolError = validateHookTool(parsed.data.actionConfig.toolName);
      if (toolError) throw new BadRequestException(toolError);
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const hook = await updateHook(instanceId, id, parsed.data);
    if (!hook) throw new NotFoundException("Hook not found");
    invalidateHooksCache(asInstanceSlug(slug));
    return { hook };
  }

  @Delete(":id")
  async remove(@Param("slug") slug: string, @Param("id") id: string) {
    if (!UUID_RE.test(id)) throw new BadRequestException("Invalid hook id");
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const deleted = await deleteHook(instanceId, id);
    if (!deleted) throw new NotFoundException("Hook not found");
    invalidateHooksCache(asInstanceSlug(slug));
    return { deleted: true };
  }
}
