// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { conversationStore } from "../../conversations/store.js";
import { parsePagination } from "../utils/parse-pagination.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

import { type InstanceSlug } from "../../instances/identifiers.js";

function requireInstanceId(instanceId: string | undefined): InstanceSlug {
  const trimmed = instanceId?.trim();
  if (!trimmed) throw new BadRequestException("instanceId is required");
  return asInstanceSlug(trimmed);
}

/**
 * Look up a conversation and verify it belongs to the requested instance scope.
 * Returns 404 on either miss or mismatch — never reveals existence across instances.
 */
async function loadConversationScoped(conversationId: string, instanceId: InstanceSlug) {
  const conversation = await conversationStore.getConversation(conversationId);
  if (!conversation || conversation.instanceId !== instanceId) {
    throw new NotFoundException(`Conversation not found: ${conversationId}`);
  }
  return conversation;
}

@Controller("api/conversations")
export class ConversationsController {
  @Get()
  async list(
    @Query("instanceId") instanceId?: string,
    @Query("source") source?: string,
    @Query("search") search?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
  ) {
    const { limit, offset } = parsePagination(limitStr, offsetStr, { defaultLimit: 20, maxLimit: 100 });
    const instanceSlug = instanceId ? asInstanceSlug(instanceId) : undefined;

    if (search) {
      const result = await conversationStore.searchConversations(search, {
        instanceId: instanceSlug,
        limit,
        offset,
      });
      return { ...result, limit, offset };
    }

    const result = await conversationStore.listConversations({
      instanceId: instanceSlug,
      source,
      limit,
      offset,
    });
    return { ...result, limit, offset };
  }

  @Get(":conversationId")
  async getOne(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    const conversation = await loadConversationScoped(id, uid);
    return { conversation };
  }

  @Get(":conversationId/messages")
  async getMessages(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
    @Query("order") orderStr?: string,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    await loadConversationScoped(id, uid);

    const { limit, offset } = parsePagination(limitStr, offsetStr);
    const order: "asc" | "desc" = orderStr === "desc" ? "desc" : "asc";

    const [result, tokenStats] = await Promise.all([
      conversationStore.getMessages(id, { limit, offset, order }),
      conversationStore.getMessageTokenStats(id),
    ]);
    const messages = result.messages.map((m) => ({
      ...m,
      promptTokens: tokenStats[m.id]?.promptTokens ?? null,
      completionTokens: tokenStats[m.id]?.completionTokens ?? null,
    }));
    return { messages, total: result.total, limit, offset, order };
  }

  @Delete(":conversationId")
  async remove(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    await loadConversationScoped(id, uid);

    const deleted = await conversationStore.deleteConversation(id);
    if (!deleted) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }
    return { deleted: true };
  }
}
