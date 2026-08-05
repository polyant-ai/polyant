// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";

const PROVIDER_TOOL_IDENTIFIER = /[^a-zA-Z0-9_-]/g;

/**
 * Convert a canonical tool name to the identifier sent to an LLM provider.
 *
 * Keep ':' mapped to '__' for backward-compatible plugin namespaces, then map
 * every other invalid character. Bedrock, OpenAI, and Anthropic all require
 * `[a-zA-Z0-9_-]+` for tool names.
 */
export function toModelToolName(name: string): string {
  return name.replace(/:/g, "__").replace(PROVIDER_TOOL_IDENTIFIER, "_") || "_";
}

/**
 * Bedrock rejects tool call ids containing any character outside its identifier
 * grammar. Apply the same mapping to calls and results so their pairing holds.
 */
export function sanitizeToolCallId(id: string): string {
  return id.replace(PROVIDER_TOOL_IDENTIFIER, "_") || "_";
}

/**
 * Normalize identifiers in already-built tool messages at the final provider
 * boundary. This protects direct callers that bypass the normal tool registry
 * or persisted-history replay paths.
 *
 * Returns the original array when every identifier is already provider-safe.
 */
export function sanitizeToolWireMessages(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;

  const sanitized = messages.map((message): ModelMessage => {
    if (!Array.isArray(message.content)) return message;

    let messageChanged = false;
    const content = (message.content as unknown[]).map((part) => {
      if (!part || typeof part !== "object") return part;

      const wirePart = part as Record<string, unknown>;
      if (wirePart.type !== "tool-call" && wirePart.type !== "tool-result") return part;

      const toolName = typeof wirePart.toolName === "string"
        ? toModelToolName(wirePart.toolName)
        : wirePart.toolName;
      const toolCallId = typeof wirePart.toolCallId === "string"
        ? sanitizeToolCallId(wirePart.toolCallId)
        : wirePart.toolCallId;

      if (toolName === wirePart.toolName && toolCallId === wirePart.toolCallId) return part;

      messageChanged = true;
      return { ...wirePart, toolName, toolCallId };
    });

    if (!messageChanged) return message;
    changed = true;
    return { ...message, content } as unknown as ModelMessage;
  });

  return changed ? sanitized : messages;
}
