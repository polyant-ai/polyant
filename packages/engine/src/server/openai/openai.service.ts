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
import { listActiveInstances, type Agent } from "../../instances/store.js";
import { asAgentSlug, type AgentSlug } from "../../instances/identifiers.js";

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

  async listInstances(): Promise<Agent[]> {
    return listActiveInstances();
  }

  async chatCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const { text, conversationHistory, systemMessages, agentId, channelId } =
      this.prepareRequest(request);

    // Call the pipeline via messageHandler
    const result = await this.messageHandler({
      channelType: "web",
      channelId,
      agentId,
      text,
      metadata: { conversationHistory, systemMessages },
    });

    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

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
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  async chatCompletionStream(
    request: ChatCompletionRequest,
  ): Promise<StreamOutgoingMessage> {
    const { text, conversationHistory, systemMessages, agentId, channelId } =
      this.prepareRequest(request);

    return this.streamMessageHandler({
      channelType: "web",
      channelId,
      agentId,
      text,
      metadata: { conversationHistory, systemMessages },
    });
  }

  private prepareRequest(request: ChatCompletionRequest): {
    text: string;
    conversationHistory: ModelMessage[];
    systemMessages: Array<{ role: "system"; content: string }>;
    agentId: AgentSlug;
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

    // Extract system messages from this request (to be persisted)
    const systemMessages = messages
      .filter((m): m is ChatCompletionMessage & { role: "system" } => m.role === "system")
      .map((m) => ({ role: "system" as const, content: m.content }));

    // Use the model field as instance slug (falls back to default).
    // `request.model` is the client-chosen instance slug; its existence is validated downstream by findInstanceBySlug.
    const agentId = request.model ? asAgentSlug(request.model) : DEFAULT_INSTANCE_ID;

    const channelId = this.deriveChannelId(messages, chat_id);

    return { text, conversationHistory, systemMessages, agentId, channelId };
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

  private toModelMessages(messages: ChatCompletionMessage[]): ModelMessage[] {
    return messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));
  }
}
