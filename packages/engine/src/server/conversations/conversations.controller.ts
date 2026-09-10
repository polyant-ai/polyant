// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { conversationStore } from "../../conversations/store.js";
import { loadConversationState } from "../../conversations/state.store.js";
import { listHookExecutions } from "../../hooks/hook-executions.store.js";
import { parsePagination } from "../utils/parse-pagination.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { callerTenantScope } from "../utils/caller-tenant-scope.js";
import type { TenantScope } from "../../authz/scope-filter.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";

/** RFC-4122 UUID shape — guards the message-id path param before it hits the uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { type InstanceSlug } from "../../instances/identifiers.js";
import { RequirePermission, Permission } from "../../authz/index.js";

function requireInstanceId(instanceId: string | undefined): InstanceSlug {
  const trimmed = instanceId?.trim();
  if (!trimmed) throw new BadRequestException("instanceId is required");
  return asInstanceSlug(trimmed);
}

/** Parse an optional ISO-8601 datetime query param; 400 on a malformed value. */
function parseIsoDateParam(name: string, value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${name} must be an ISO-8601 datetime`);
  }
  return d;
}

/**
 * Look up a conversation and verify it belongs to the requested instance scope.
 * Returns 404 on either miss or mismatch — never reveals existence across instances.
 */
async function loadConversationScoped(
  conversationId: string,
  instanceId: InstanceSlug,
  scope: TenantScope,
) {
  // The tenant filter scopes the lookup to the caller's organization; the
  // instanceId check narrows to the requested agent. A foreign-org id misses on
  // both counts.
  const conversation = await conversationStore.getConversation(conversationId, scope);
  if (!conversation || conversation.instanceId !== instanceId) {
    throw new NotFoundException(`Conversation not found: ${conversationId}`);
  }
  return conversation;
}

@Controller("api/conversations")
export class ConversationsController {
  @RequirePermission(Permission.CONVERSATION_READ)
  @Get()
  async list(
    @Query("instanceId") instanceId?: string,
    @Query("source") source?: string,
    @Query("search") search?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
    @Query("updatedSince") updatedSinceStr?: string,
    @Query("updatedUntil") updatedUntilStr?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const { limit, offset } = parsePagination(limitStr, offsetStr, { defaultLimit: 20, maxLimit: 100 });
    const instanceSlug = instanceId ? asInstanceSlug(instanceId) : undefined;
    // Resolved, not the raw claim: the store's org filter fails closed on a
    // missing orgId, so a principal whose JWT predates the claim would otherwise
    // see an empty list on a perfectly ordinary single-org deployment.
    const scope = await callerTenantScope(user);

    if (search) {
      const result = await conversationStore.searchConversations(search, {
        instanceId: instanceSlug,
        limit,
        offset,
        scope,
      });
      return { ...result, limit, offset };
    }

    // Half-open [updatedSince, updatedUntil) window on updated_at — applies to
    // the list path only (the search path is FTS-ranked, not time-windowed).
    const updatedSince = parseIsoDateParam("updatedSince", updatedSinceStr);
    const updatedUntil = parseIsoDateParam("updatedUntil", updatedUntilStr);

    const result = await conversationStore.listConversations({
      instanceId: instanceSlug,
      source,
      updatedSince,
      updatedUntil,
      limit,
      offset,
      scope,
    });
    return { ...result, limit, offset };
  }

  @RequirePermission(Permission.CONVERSATION_READ)
  @Get(":conversationId")
  async getOne(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    const conversation = await loadConversationScoped(id, uid, await callerTenantScope(user));
    return { conversation };
  }

  @RequirePermission(Permission.CONVERSATION_READ)
  @Get(":conversationId/messages")
  async getMessages(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
    @Query("limit") limitStr?: string,
    @Query("offset") offsetStr?: string,
    @Query("order") orderStr?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    await loadConversationScoped(id, uid, await callerTenantScope(user));

    const { limit, offset } = parsePagination(limitStr, offsetStr);
    const order: "asc" | "desc" = orderStr === "desc" ? "desc" : "asc";

    const [result, tokenStats] = await Promise.all([
      conversationStore.getMessages(id, { limit, offset, order }),
      conversationStore.getMessageTokenStats(id),
    ]);
    const messages = result.messages.map((m) => {
      const stats = tokenStats[m.id];
      return {
        ...m,
        promptTokens: stats?.promptTokens ?? null,
        completionTokens: stats?.completionTokens ?? null,
        cachedInputTokens: stats?.cachedInputTokens ?? null,
        cacheCreationInputTokens: stats?.cacheCreationInputTokens ?? null,
        model: stats?.model ?? null,
        provider: stats?.provider ?? null,
        cost: stats?.cost ?? null,
        thinking: stats?.thinking ?? null,
        temperature: stats?.temperature ?? null,
        latency: stats?.latency ?? null,
      };
    });
    return { messages, total: result.total, limit, offset, order };
  }

  // GET /api/conversations/:conversationId/messages/:messageId/debug — heavy per-turn
  // debug data (captured LLM request payload + step trace), fetched on-demand so the
  // message-list payload stays light. Returns 404 if the message isn't in the conversation.
  @RequirePermission(Permission.CONVERSATION_READ)
  @Get(":conversationId/messages/:messageId/debug")
  async getMessageDebug(
    @Param("conversationId") conversationId: string,
    @Param("messageId") messageId: string,
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    if (!UUID_RE.test(messageId)) throw new BadRequestException("messageId must be a UUID");
    const id = decodeURIComponent(conversationId);
    await loadConversationScoped(id, uid, await callerTenantScope(user));

    const debug = await conversationStore.getMessageDebug(id, messageId);
    if (!debug) throw new NotFoundException(`Message not found: ${messageId}`);
    return debug;
  }

  // GET /api/conversations/:conversationId/hooks — lifecycle hook execution
  // telemetry for this conversation (timeline order), rendered in the detail UI.
  @RequirePermission(Permission.CONVERSATION_READ)
  @Get(":conversationId/hooks")
  async getHookExecutions(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    await loadConversationScoped(id, uid, await callerTenantScope(user));

    const executions = await listHookExecutions(id);
    return { executions };
  }

  // GET /api/conversations/:conversationId/state — the conversation state store snapshot
  // (latest, not versioned per turn). Includes the server-seeded `_channel` identity.
  @RequirePermission(Permission.CONVERSATION_READ)
  @Get(":conversationId/state")
  async getState(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    await loadConversationScoped(id, uid, await callerTenantScope(user));

    const state = await loadConversationState(id);
    return { state };
  }

  // PATCH /api/conversations/:conversationId — rename the conversation's stable
  // text key (propagated across every linked table) and/or its title. No dedicated
  // conversation-write permission exists; this is a mutation of comparable weight
  // to delete, so it reuses CONVERSATION_DELETE as the write gate.
  @RequirePermission(Permission.CONVERSATION_DELETE)
  @Patch(":conversationId")
  async rename(
    @Param("conversationId") conversationId: string,
    @Body() body: { conversationId?: string; title?: string },
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    const scope = await callerTenantScope(user);
    await loadConversationScoped(id, uid, scope);

    const rawNewId = body.conversationId?.trim();
    const rawTitle = body.title?.trim();
    if (body.conversationId === undefined && body.title === undefined) {
      throw new BadRequestException("Provide conversationId and/or title to update");
    }
    if (body.title !== undefined && !rawTitle) {
      throw new BadRequestException("title must not be empty");
    }

    const targetId = rawNewId && rawNewId.length > 0 ? rawNewId : id;
    if (targetId !== id) {
      // The web derives the instance scope from the id prefix and the row's
      // instance_id column is NOT changed by a rename — a different prefix would
      // make the conversation unopenable and break IDOR scoping. Pin the prefix.
      if (targetId.split(":")[0] !== uid) {
        throw new BadRequestException(`conversationId must start with "${uid}:"`);
      }
      const existing = await conversationStore.getConversation(targetId, scope);
      if (existing) {
        throw new ConflictException(`Conversation id already in use: ${targetId}`);
      }
    }

    await conversationStore.renameConversation(id, targetId, scope, rawTitle);
    return { renamed: true, conversationId: targetId };
  }

  @RequirePermission(Permission.CONVERSATION_DELETE)
  @Delete(":conversationId")
  async remove(
    @Param("conversationId") conversationId: string,
    @Query("instanceId") instanceId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const uid = requireInstanceId(instanceId);
    const id = decodeURIComponent(conversationId);
    const scope = await callerTenantScope(user);
    await loadConversationScoped(id, uid, scope);

    const deleted = await conversationStore.deleteConversation(id, scope);
    if (!deleted) {
      throw new NotFoundException(`Conversation not found: ${id}`);
    }
    return { deleted: true };
  }
}
