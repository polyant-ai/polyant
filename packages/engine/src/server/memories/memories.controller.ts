// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Post, Delete, Param, Query, Body, BadRequestException, NotFoundException } from "@nestjs/common";
import { searchMemories, deleteAllMemories, upsertMemory, deleteMemoryForInstance } from "../../memory/memory-store.js";
import { embedMany, resolveEmbeddingContext } from "../../embeddings-gateway/index.js";
import { asAgentSlug, type AgentSlug } from "../../instances/identifiers.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { callerMayAccessAgent } from "../../authz/agent-tenancy.js";
import { resolvePrincipalOrgId } from "../../instances/store.js";

function requireInstanceId(instanceId: string | undefined): AgentSlug {
  const trimmed = instanceId?.trim();
  if (!trimmed) throw new BadRequestException("instanceId is required");
  return asAgentSlug(trimmed);
}

@Controller("memories")
export class MemoriesController {
  @RequirePermission(Permission.MEMORY_READ)
  @Get()
  async listAll(
    @Query("instanceId") instanceId?: string,
    @Query("search") search?: string,
    @Query("category") category?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const limit = Math.min(Math.max(limitStr ? Number(limitStr) || 20 : 20, 1), 100);
    const offset = Math.max(offsetStr ? Number(offsetStr) || 0 : 0, 0);

    const orgId = (await resolvePrincipalOrgId(user?.orgId)) ?? undefined;
    const result = await searchMemories(uid, { search, category, limit, offset, orgId });
    return {
      total: result.total,
      limit,
      offset,
      memories: result.memories.map((m) => ({
        id: m.id,
        instanceId: m.instanceId,
        content: m.content,
        category: m.category,
        importance: m.importance,
        sourceConversationId: m.sourceConversationId,
        createdAt: m.createdAt?.toISOString() ?? null,
        updatedAt: m.updatedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * The agent is named in the BODY, not in `params.slug`, so PermissionGuard
   * authorizes this at the caller's own org level and cannot tie `instanceId` to
   * the caller's tenancy. Without the explicit check below, a member of one
   * organization could write into any other organization's agent — and a memory
   * is injected into that agent's supervisor prompt on its next matching turn,
   * so this was durable cross-tenant prompt injection, not merely a stray row.
   *
   * `listAll`/`remove`/`removeAll` were already scoped (they pass `orgId` into
   * the store); `create` was the one write that read no caller at all.
   */
  @RequirePermission(Permission.MEMORY_WRITE)
  @Post()
  async create(
    @Body() body: { instanceId?: string; content: string; category?: string; importance?: number },
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(body.instanceId);
    if (!body.content?.trim()) {
      throw new BadRequestException("content is required");
    }
    // 404, not 403: a caller of another organization must not learn it exists.
    if (!(await callerMayAccessAgent(uid, user))) {
      throw new NotFoundException(`Agent "${uid}" not found`);
    }

    const embCtx = await resolveEmbeddingContext(uid).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Embedding provider not configured.";
      throw new BadRequestException(message);
    });
    const [embedding] = await embedMany([body.content], embCtx);
    const result = await upsertMemory({
      instanceId: uid,
      content: body.content.trim(),
      category: body.category ?? "general",
      importance: body.importance ?? 5,
      embedding,
      dimensions: embCtx.dimensions,
      provider: embCtx.credentials.provider,
    });
    return { memory: result };
  }

  @RequirePermission(Permission.MEMORY_WRITE)
  @Delete(":id")
  async remove(
    @Param("id") id: string,
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const deleted = await deleteMemoryForInstance(id, uid, (await resolvePrincipalOrgId(user?.orgId)) ?? undefined);
    if (!deleted) throw new NotFoundException(`Memory "${id}" not found`);
    return { deleted: true };
  }

  @RequirePermission(Permission.MEMORY_WRITE)
  @Delete()
  async removeAll(
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    await deleteAllMemories(uid, (await resolvePrincipalOrgId(user?.orgId)) ?? undefined);
    return { deleted: true };
  }
}
