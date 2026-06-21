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
import { resolveAgentId } from "../../instances/resolve-agent-id.js";
import { asAgentSlug } from "../../instances/identifiers.js";
import { RequirePermission, Permission } from "../../authz/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller(["api/agents/:slug/hooks", "api/instances/:slug/hooks"])
export class InstanceHooksController {
  @RequirePermission(Permission.GOVERNANCE_READ)
  @Get()
  async list(@Param("slug") slug: string) {
    const agentId = await resolveAgentId(asAgentSlug(slug));
    if (!agentId) throw new NotFoundException("Agent not found");
    return { hooks: await listHooks(agentId) };
  }

  @RequirePermission(Permission.GOVERNANCE_WRITE)
  @Post()
  async create(@Param("slug") slug: string, @Body() body: unknown) {
    const parsed = createHookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }
    const toolError = validateHookTool(parsed.data.actionConfig.toolName);
    if (toolError) throw new BadRequestException(toolError);

    const agentId = await resolveAgentId(asAgentSlug(slug));
    if (!agentId) throw new NotFoundException("Agent not found");

    const hook = await createHook(agentId, parsed.data);
    invalidateHooksCache(asAgentSlug(slug));
    return { hook };
  }

  @RequirePermission(Permission.GOVERNANCE_WRITE)
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

    const agentId = await resolveAgentId(asAgentSlug(slug));
    if (!agentId) throw new NotFoundException("Agent not found");

    const hook = await updateHook(agentId, id, parsed.data);
    if (!hook) throw new NotFoundException("Hook not found");
    invalidateHooksCache(asAgentSlug(slug));
    return { hook };
  }

  @RequirePermission(Permission.GOVERNANCE_WRITE)
  @Delete(":id")
  async remove(@Param("slug") slug: string, @Param("id") id: string) {
    if (!UUID_RE.test(id)) throw new BadRequestException("Invalid hook id");
    const agentId = await resolveAgentId(asAgentSlug(slug));
    if (!agentId) throw new NotFoundException("Agent not found");

    const deleted = await deleteHook(agentId, id);
    if (!deleted) throw new NotFoundException("Hook not found");
    invalidateHooksCache(asAgentSlug(slug));
    return { deleted: true };
  }
}
