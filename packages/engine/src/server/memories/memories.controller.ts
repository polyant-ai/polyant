// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Post, Delete, Param, Query, Body, BadRequestException, NotFoundException } from "@nestjs/common";
import { searchMemories, deleteAllMemories, upsertMemory, deleteMemoryForInstance } from "../../memory/memory-store.js";
import { generateEmbeddings } from "../../memory/embedder.js";
import { getAllSecrets } from "../../instances/secrets.store.js";
import { asInstanceSlug, type InstanceSlug } from "../../instances/identifiers.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { RequirePermission, Permission } from "../../authz/index.js";

function requireInstanceId(instanceId: string | undefined): InstanceSlug {
  const trimmed = instanceId?.trim();
  if (!trimmed) throw new BadRequestException("instanceId is required");
  return asInstanceSlug(trimmed);
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

    const result = await searchMemories(uid, { search, category, limit, offset, orgId: user?.orgId });
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

  @RequirePermission(Permission.MEMORY_WRITE)
  @Post()
  async create(
    @Body() body: { instanceId?: string; content: string; category?: string; importance?: number },
  ) {
    const uid = requireInstanceId(body.instanceId);
    if (!body.content?.trim()) {
      throw new BadRequestException("content is required");
    }

    const secrets = await getAllSecrets(uid);
    const openaiKey = secrets["openai_api_key"];
    if (!openaiKey) {
      throw new BadRequestException(
        "OpenAI API key not configured for this instance. Embeddings require an OpenAI key.",
      );
    }
    const [embedding] = await generateEmbeddings([body.content], openaiKey);
    const result = await upsertMemory({
      instanceId: uid,
      content: body.content.trim(),
      category: body.category ?? "general",
      importance: body.importance ?? 5,
      embedding,
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
    const deleted = await deleteMemoryForInstance(id, uid, user?.orgId);
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
    await deleteAllMemories(uid, user?.orgId);
    return { deleted: true };
  }
}
