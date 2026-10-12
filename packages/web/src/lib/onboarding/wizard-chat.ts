// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

export interface WizardChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WizardChatCallbacks {
  onText: (delta: string) => void;
}

/**
 * Sends the conversation through the agent's Web channel and reads the reply.
 *
 * The same route and credential an outside caller uses: it answers only while Web
 * is on and presents the agent key as a Bearer token. Resolves with the reply
 * text; rejects with a message the person can read.
 */
export async function sendWizardChat(
  slug: string,
  options: {
    messages: WizardChatMessage[];
    chatId: string;
    agentKey?: string;
    signal?: AbortSignal;
    errors: { network: string; http: (status: number) => string };
  },
  callbacks: WizardChatCallbacks,
): Promise<string> {
  let response: Response;
  try {
    response = await api.instances.webChatStream(
      slug,
      { messages: options.messages, chatId: options.chatId },
      { agentKey: options.agentKey, signal: options.signal },
    );
  } catch {
    throw new Error(options.errors.network);
  }
  if (!response.ok || !response.body) throw new Error(options.errors.http(response.status));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let failure: string | null = null;

  const handle = (block: string) => {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!event || !data) return;
    try {
      const payload = JSON.parse(data) as { text?: unknown; message?: unknown };
      if (event === "text-delta" && typeof payload.text === "string") {
        reply += payload.text;
        callbacks.onText(payload.text);
      } else if (event === "error" && typeof payload.message === "string") {
        failure = payload.message;
      }
    } catch {
      // A malformed event is skipped; the rest of the stream still carries the reply.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      handle(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) handle(buffer);
  if (failure && !reply) throw new Error(failure);
  return reply;
}
