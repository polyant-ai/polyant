// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Post, Delete, Param, Query, Body, BadRequestException, NotFoundException } from "@nestjs/common";
import { searchMemories, deleteAllMemories, upsertMemory, deleteMemoryForInstance } from "../../memory/memory-store.js";
import { embedMany, resolveEmbeddingContext } from "../../embeddings-gateway/index.js";
import { asAgentSlug, type AgentSlug } from "../../instances/identifiers.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { RequirePermission, Permission } from "../../authz/index.js";

function requireInstanceId(agentId: string | undefined): AgentSlug {
  const trimmed = agentId?.trim();
  if (!trimmed) throw new BadRequestException("agentId is required");
  return asAgentSlug(trimmed);
}

@Controller("memories")
export class MemoriesController {
  @RequirePermission(Permission.MEMORY_READ)
  @Get()
  async listAll(
    @Query("agentId") agentId?: string,
    @Query("search") search?: string,
    @Query("category") category?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(agentId);
    const limit = Math.min(Math.max(limitStr ? Number(limitStr) || 20 : 20, 1), 100);
    const offset = Math.max(offsetStr ? Number(offsetStr) || 0 : 0, 0);

    const result = await searchMemories(uid, { search, category, limit, offset, orgId: user?.orgId });
    return {
      total: result.total,
      limit,
      offset,
      memories: result.memories.map((m) => ({
        id: m.id,
        agentId: m.agentId,
        content: m.content,
        category: m.category,
        importance: m.importance,
        sourceConversationId: m.sourceConversationId,
        createdAt: m.createdAt?.toISOString() ?? null,
        updatedAt: m.updatedAt?.toISOString() ?? null,
      })),
    };
  }

  @RequirePermission(Permission.MEMORY_WRITE)
  @Post()
  async create(
    @Body() body: { agentId?: string; content: string; category?: string; importance?: number },
  ) {
    const uid = requireInstanceId(body.agentId);
    if (!body.content?.trim()) {
      throw new BadRequestException("content is required");
    }

    const embCtx = await resolveEmbeddingContext(uid).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Embedding provider not configured.";
      throw new BadRequestException(message);
    });
    const [embedding] = await embedMany([body.content], embCtx);
    const result = await upsertMemory({
      agentId: uid,
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
    @Query("agentId") agentId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(agentId);
    const deleted = await deleteMemoryForInstance(id, uid, user?.orgId);
    if (!deleted) throw new NotFoundException(`Memory "${id}" not found`);
    return { deleted: true };
  }

  @RequirePermission(Permission.MEMORY_WRITE)
  @Delete()
  async removeAll(
    @Query("agentId") agentId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(agentId);
    await deleteAllMemories(uid, user?.orgId);
    return { deleted: true };
  }
}
