// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Put, Delete, Post, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { asInstanceUuid } from "../../instances/identifiers.js";
import { findInstanceOrFail, maskSensitiveConfig } from "./instance-helpers.js";
import {
  setMcpServer,
  getMcpServer,
  listMcpServers,
  deleteMcpServer,
  MCP_AUTH_MODES,
  mcpServerConfigSchema,
} from "../../instances/mcp-servers.store.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";
import { testMcpConnection } from "../../agents/tools/mcp/mcp-test.js";
import { assertSafeMcpUrl } from "../../agents/tools/mcp/mcp-url-guard.js";

const setBodySchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  authMode: z.enum(MCP_AUTH_MODES),
  enabled: z.boolean(),
  config: z.record(z.unknown()),
});

@Controller("api/instances")
export class McpServersController {
  private readonly auditLogger = createManagementAuditLogger();

  @RequirePermission(Permission.CHANNEL_READ)
  @Get(":slug/mcp-servers")
  async list(@Param("slug") slug: string) {
    const inst = await findInstanceOrFail(slug);
    const servers = await listMcpServers(asInstanceUuid(inst.id));
    return servers.map((s) => ({ ...s, config: maskSensitiveConfig(s.config as Record<string, unknown>) }));
  }

  @RequirePermission(Permission.CHANNEL_WRITE)
  @Put(":slug/mcp-servers/:serverSlug")
  async set(
    @Param("slug") slug: string,
    @Param("serverSlug") serverSlug: string,
    @Body() body: unknown,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const parsed = setBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }
    assertSafeMcpUrl(parsed.data.url);

    const inst = await findInstanceOrFail(slug);

    // Merge masked (••••) values back to the existing config to preserve
    // unchanged secrets (same pattern as InstanceChannelsController.setChannel).
    const existing = await getMcpServer(asInstanceUuid(inst.id), serverSlug);
    const merged: Record<string, unknown> = { ...((existing?.config as Record<string, unknown>) ?? {}) };
    for (const [k, v] of Object.entries(parsed.data.config)) {
      if (typeof v === "string" && v.startsWith("••••")) continue;
      merged[k] = v;
    }
    mcpServerConfigSchema(parsed.data.authMode, merged); // validate the effective config

    await setMcpServer(asInstanceUuid(inst.id), {
      slug: serverSlug,
      name: parsed.data.name,
      url: parsed.data.url,
      authMode: parsed.data.authMode,
      enabled: parsed.data.enabled,
      config: merged,
    });
    this.auditLogger.log({
      action: ManagementAuditAction.McpServerWrite,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.McpServer,
      targetId: serverSlug,
      metadata: { instanceSlug: slug },
    });
    return { ok: true };
  }

  @RequirePermission(Permission.CHANNEL_WRITE)
  @Delete(":slug/mcp-servers/:serverSlug")
  async remove(
    @Param("slug") slug: string,
    @Param("serverSlug") serverSlug: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const inst = await findInstanceOrFail(slug);
    await deleteMcpServer(asInstanceUuid(inst.id), serverSlug);
    this.auditLogger.log({
      action: ManagementAuditAction.McpServerDelete,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.McpServer,
      targetId: serverSlug,
      metadata: { instanceSlug: slug },
    });
    return { deleted: true };
  }

  @RequirePermission(Permission.CHANNEL_WRITE)
  @Post(":slug/mcp-servers/test")
  async test(@Param("slug") slug: string, @Body() body: unknown) {
    const parsed = setBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }
    assertSafeMcpUrl(parsed.data.url);

    await findInstanceOrFail(slug);
    return testMcpConnection({
      url: parsed.data.url,
      authMode: parsed.data.authMode,
      config: parsed.data.config,
    });
  }
}
