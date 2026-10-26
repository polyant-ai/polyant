// SPDX-License-Identifier: AGPL-3.0-or-later

import { contactConversationId } from "../channels/outbound-conversation.js";
import { TtlCache } from "../utils/ttl-cache.js";

const TRIGGER_TTL_MS = 24 * 60 * 60 * 1000;

// A contact who never replies leaves an entry nobody reads again; the cache's
// own sweep and size bound are what remove it.
const triggers = new TtlCache<string, string>({ maxSize: 10_000, ttlMs: TRIGGER_TTL_MS });

export function registerTrigger(
  instanceId: string,
  channelType: string,
  channelId: string,
  conversationId: string,
): void {
  triggers.set(contactConversationId(instanceId, channelType, channelId), conversationId);
}

export function getActiveTrigger(
  instanceId: string,
  channelType: string,
  channelId: string,
): string | null {
  return triggers.get(contactConversationId(instanceId, channelType, channelId)) ?? null;
}
