// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decide, for a single inbound turn, what to persist as the assistant message
 * and whether the channel adapter still needs to deliver anything.
 *
 * A tool may deliver its own reply during execution (e.g. `send_whatsapp_template`
 * sends an interactive Content template and returns `replyHandled: true`). In
 * that case the adapter must NOT send a second message, and the persisted turn
 * should be the tool's rendered reply — not the LLM free-form text. Mirrors the
 * precedence the webhook engine already uses.
 */
export interface DeliveredReply {
  /** Text to persist as the assistant turn (conversation history). */
  persistText: string;
  /** True when a tool already delivered the reply — the adapter sends nothing more. */
  toolDelivered: boolean;
}

export function resolveDeliveredReply(input: {
  replyHandled?: boolean;
  replyText?: string;
  llmText: string;
}): DeliveredReply {
  const toolDelivered = input.replyHandled === true;
  const persistText = toolDelivered && input.replyText ? input.replyText : input.llmText;
  return { persistText, toolDelivered };
}
