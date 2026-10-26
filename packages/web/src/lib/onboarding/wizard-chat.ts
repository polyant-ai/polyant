// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  streamChatCompletion,
  type StreamErrorMessages,
} from "@/lib/stream-parser";

export interface WizardChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Sends the conversation through the panel's own playground session route, the
 * same client the Playground page uses: it needs the caller's session, no agent
 * key and no Web channel. Resolves with the full reply; rejects with a message the
 * person can read.
 */
export function sendWizardChat(
  slug: string,
  options: {
    messages: WizardChatMessage[];
    chatId: string;
    signal?: AbortSignal;
    errorMessages: StreamErrorMessages;
  },
  onText: (delta: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = "";
    const noop = () => {};
    void streamChatCompletion(
      {
        instanceSlug: slug,
        messages: options.messages,
        chatId: options.chatId,
        signal: options.signal,
        errorMessages: options.errorMessages,
      },
      {
        onTextDelta: (text) => {
          reply += text;
          onText(text);
        },
        onReasoningDelta: noop,
        onStepStart: noop,
        onStepFinish: noop,
        onToolCall: noop,
        onToolResult: noop,
        onDone: () => resolve(reply),
        onError: (error) => reject(error),
      },
    );
  });
}
