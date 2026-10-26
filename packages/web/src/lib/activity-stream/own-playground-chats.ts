// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Playground chats this browser tab has started.
 *
 * The Playground mints its chat id on the client and the engine derives the
 * conversation's channel id from it (`api-${chatId}`), so the panel knows the
 * conversation before the engine announces it. The header ticker uses that to
 * stay quiet about "new conversation" events the person caused themselves.
 * Kept in memory on purpose: it only has to outlive the few seconds in which
 * the ticker still shows a live event.
 */
const ownChannelIds = new Set<string>();

export function rememberPlaygroundChat(chatId: string): void {
  ownChannelIds.add(`api-${chatId}`);
}

/** Whether a conversation id (`{agent}:{channel}:{channelId}`) is one of ours. */
export function isOwnPlaygroundConversation(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const channelId = conversationId.split(":").slice(2).join(":");
  return ownChannelIds.has(channelId);
}
