// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { ModelMessage } from "ai";
import type { MessageHandler, StreamMessageHandler, StreamOutgoingMessage } from "../../channels/types.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionMessage,
} from "./openai.types.js";
import { DEFAULT_INSTANCE_ID } from "../../config.js";
import {
  findInstanceBySlug,
  listActiveInstances,
  resolvePrincipalOrgId,
  type Instance,
} from "../../instances/store.js";
import { asInstanceSlug, type InstanceSlug } from "../../instances/identifiers.js";

/**
 * The two principal shapes that can reach GET /v1/models (see AuthGuard): a
 * per-instance API key, bound to a single agent, or a human/service principal
 * carrying an organization.
 */
export type ModelsPrincipal =
  | { readonly kind: "instance"; readonly instanceSlug: string }
  | { readonly kind?: undefined; readonly orgId?: string };

@Injectable()
export class OpenAIService {
  private messageHandler!: MessageHandler;
  private streamMessageHandler!: StreamMessageHandler;

  setMessageHandler(handler: MessageHandler) {
    this.messageHandler = handler;
  }

  setStreamMessageHandler(handler: StreamMessageHandler) {
    this.streamMessageHandler = handler;
  }

  /**
   * The agents the caller is allowed to see.
   *
   * A per-instance API key is bound to ONE agent, so it only ever sees that one —
   * listing the whole deployment from a single agent's key was a cross-tenant
   * enumeration. Any other principal sees the active agents of its own
   * organization; when the organization cannot be resolved the list is empty
   * (fail closed) rather than every agent.
   */
  async listInstances(principal?: ModelsPrincipal): Promise<Instance[]> {
    if (principal?.kind === "instance") {
      const own = await findInstanceBySlug(asInstanceSlug(principal.instanceSlug));
      return own && own.status === "active" ? [own] : [];
    }
    const orgId = await resolvePrincipalOrgId(principal?.orgId);
    return orgId ? listActiveInstances(orgId) : [];
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const { text, conversationHistory, instanceId, channelId } =
      this.prepareRequest(request);

    // Call the pipeline via messageHandler
    const result = await this.messageHandler({
      channelType: "web",
      channelId,
      instanceId,
      text,
      metadata: { conversationHistory },
    });

    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // The pipeline reports what the turn actually spent; OpenAI-compatible
    // clients meter cost from this block, so report it rather than zeros.
    // Multi-step turns are already summed upstream. Falls back to 0 only when
    // the provider returned no usage at all.
    const promptTokens = result.usage?.promptTokens ?? 0;
    const completionTokens = result.usage?.completionTokens ?? 0;

    return {
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  async chatCompletionStream(
    request: ChatCompletionRequest,
  ): Promise<StreamOutgoingMessage> {
    const { text, conversationHistory, instanceId, channelId } =
      this.prepareRequest(request);

    return this.streamMessageHandler({
      channelType: "web",
      channelId,
      instanceId,
      text,
      metadata: { conversationHistory },
    });
  }

  private prepareRequest(request: ChatCompletionRequest): {
    text: string;
    conversationHistory: ModelMessage[];
    instanceId: InstanceSlug;
    channelId: string;
  } {
    const { messages, chat_id } = request;

    // Extract the last user message as the main text
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const text = lastUserMsg?.content ?? "";

    // Convert previous messages to ModelMessage[] for conversation history
    const lastUserIdx = lastUserMsg
      ? messages.lastIndexOf(lastUserMsg)
      : messages.length;
    const conversationHistory = this.toModelMessages(
      messages.slice(0, lastUserIdx),
    );

    /*
      Client-supplied `system` messages are NOT collected here any more.

      They used to travel as `metadata.systemMessages`, which `foldSystemMessages`
      appended to the operator's system prompt with a bare blank line, and which
      `afterResponse` then persisted as `system` rows — so `getRecentMessages`
      replayed them on every later turn of the conversation, including turns
      arriving from Telegram or WhatsApp. On a route that is `@Public()` and, at
      the default `auth_enabled = false`, unauthenticated, that was a way to edit
      an agent's persona from the outside and make the edit stick.

      Dropping them at the source is what makes the fix real: filtering only
      `toModelMessages` would have left this second path intact.
    */
    // Use the model field as instance slug (falls back to default).
    // `request.model` is the client-chosen instance slug; its existence is validated downstream by findInstanceBySlug.
    const instanceId = request.model ? asInstanceSlug(request.model) : DEFAULT_INSTANCE_ID;

    const channelId = this.deriveChannelId(messages, chat_id);

    return { text, conversationHistory, instanceId, channelId };
  }

  /**
   * Derive a stable channelId for conversation tracking.
   * Priority: explicit chat_id from client → random UUID.
   * We intentionally avoid content-derived IDs so unrelated API clients cannot
   * collide into the same persisted conversation when they omit chat_id.
   */
  private deriveChannelId(messages: ChatCompletionMessage[], chatId?: string): string {
    if (chatId) return `api-${chatId}`;
    void messages;
    return `api-${randomUUID()}`;
  }

  /**
   * Client-supplied `system` messages are DROPPED, not honoured.
   *
   * They used to be kept, and `foldSystemMessages` concatenated them onto the end
   * of the operator's system prompt with a bare blank line — no tag, no marker of
   * provenance. On a route that is `@Public()` and, with `auth_enabled` at its
   * default, open, that let any caller append instructions to the agent's
   * persona; `afterResponse` then persisted them as `system` rows, so
   * `getRecentMessages` replayed the injection on every later turn of that
   * conversation, including turns arriving from Telegram or WhatsApp.
   *
   * Dropped rather than REJECTED with a 400, deliberately. The schema still
   * accepts the role because standard OpenAI clients always send one, and
   * because our own playground echoes back the history it loaded — which can
   * legitimately contain `system` rows the ENGINE wrote (a webhook's
   * contextPrompt is persisted exactly that way). We cannot tell our own echo
   * from a caller's injection, so we trust neither: the authoritative history
   * lives in the conversation store and is read from there.
   *
   * The agent's system prompt is the operator's. There is no route by which a
   * caller adds to it.
   */
  private toModelMessages(messages: ChatCompletionMessage[]): ModelMessage[] {
    return messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
  }
}
