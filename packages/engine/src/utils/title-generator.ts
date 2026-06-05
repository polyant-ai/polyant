// SPDX-License-Identifier: AGPL-3.0-or-later

import { chat } from "../ai-gateway/index.js";
import { conversationStore } from "../conversations/index.js";
import { asInstanceSlug } from "../instances/identifiers.js";

interface GenerateTitleOptions {
  conversationId: string;
  instanceId: string;
  provider?: string;
  apiKeys?: Record<string, string>;
  langsmith?: { apiKey: string; project: string } | null | undefined;
  content: string;
  context?: string;
}

export async function generateConversationTitle(opts: GenerateTitleOptions): Promise<void> {
  const existingTitle = await conversationStore.getTitle(opts.conversationId);
  if (existingTitle) return;

  const contextClause = opts.context ? ` ${opts.context}` : "";
  const system = `Generate a short conversation title (max 6-8 words) with a single relevant emoji at the very start. Match the language of the user's message.${contextClause} Respond ONLY with the title, nothing else. Examples: "🐍 Tutorial gioco snake in Python", "📊 Sales dashboard design"`;

  const titleResponse = await chat({
    tier: "fast",
    provider: opts.provider,
    apiKeys: opts.apiKeys,
    langsmith: opts.langsmith ?? undefined,
    system,
    messages: [{ role: "user", content: opts.content }],
  }, { conversationId: opts.conversationId, instanceId: asInstanceSlug(opts.instanceId), callType: "service" });

  const title = titleResponse.text.trim();
  if (title) {
    await conversationStore.updateTitle(opts.conversationId, title);
  }
}
