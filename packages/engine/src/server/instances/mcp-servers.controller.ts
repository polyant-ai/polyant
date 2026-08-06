// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Put, Delete, Post, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { asAgentUuid } from "../../instances/identifiers.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { maskMcpConfig, mergeMaskedMcpSecrets } from "./mcp-config-mask.js";
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

// `test` has no `:serverSlug` route param (the candidate being tested may not
// be saved yet), so — unlike `set` — it needs the slug IN the body to look up
// an existing server's secrets to restore. Optional: a first-time test of a
// brand-new server naturally has no `slug` and no existing config to merge.
const testBodySchema = setBodySchema.extend({
  slug: z.string().optional(),
});

@Controller("api/agents")
export class McpServersController {
  private readonly auditLogger = createManagementAuditLogger();

  @RequirePermission(Permission.CHANNEL_READ)
  @Get(":slug/mcp-servers")
  async list(@Param("slug") slug: string) {
    const inst = await findInstanceOrFail(slug);
    const servers = await listMcpServers(asAgentUuid(inst.id));
    return servers.map((s) => ({ ...s, config: maskMcpConfig(s.authMode, s.config as Record<string, unknown>) }));
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

    // Restore masked (••••) secret fields from the existing config so a
    // client re-submitting the masked GET response doesn't overwrite the
    // real secret (nested paths — see mcp-config-mask.ts).
    const existing = await getMcpServer(asAgentUuid(inst.id), serverSlug);
    const effective = mergeMaskedMcpSecrets(
      parsed.data.authMode,
      parsed.data.config,
      existing?.config as Record<string, unknown> | undefined,
    );
    try {
      mcpServerConfigSchema(parsed.data.authMode, effective); // validate the effective config
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException(err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      }
      throw err;
    }

    await setMcpServer(asAgentUuid(inst.id), {
      slug: serverSlug,
      name: parsed.data.name,
      url: parsed.data.url,
      authMode: parsed.data.authMode,
      enabled: parsed.data.enabled,
      config: effective,
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
    await deleteMcpServer(asAgentUuid(inst.id), serverSlug);
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
    const parsed = testBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }
    assertSafeMcpUrl(parsed.data.url);

    const inst = await findInstanceOrFail(slug);

    // Mirror `set`: restore masked (••••) secret fields from the existing
    // server config so testing an edited server without re-typing its token
    // doesn't probe the connection with no auth at all. Only possible when
    // the candidate identifies an existing server (`slug` present) — a
    // brand-new/unsaved server has nothing to restore from.
    const existing = parsed.data.slug ? await getMcpServer(asAgentUuid(inst.id), parsed.data.slug) : undefined;
    const effective = mergeMaskedMcpSecrets(
      parsed.data.authMode,
      parsed.data.config,
      existing?.config as Record<string, unknown> | undefined,
    );

    return testMcpConnection({
      url: parsed.data.url,
      authMode: parsed.data.authMode,
      config: effective,
    });
  }
}
