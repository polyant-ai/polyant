// SPDX-License-Identifier: AGPL-3.0-or-later

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface TriggerEntry {
  conversationId: string;
  expiresAt: number;
}

const triggers = new Map<string, TriggerEntry>();

function buildKey(agentId: string, channelType: string, channelId: string): string {
  return `${agentId}:${channelType}:${channelId}`;
}

export function registerTrigger(
  agentId: string,
  channelType: string,
  channelId: string,
  conversationId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  const key = buildKey(agentId, channelType, channelId);
  triggers.set(key, {
    conversationId,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getActiveTrigger(
  agentId: string,
  channelType: string,
  channelId: string,
): string | null {
  const key = buildKey(agentId, channelType, channelId);
  const entry = triggers.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() >= entry.expiresAt) {
    triggers.delete(key);
    return null;
  }

  return entry.conversationId;
}

export function clearExpiredTriggers(): void {
  const now = Date.now();
  for (const [key, entry] of triggers) {
    if (now >= entry.expiresAt) {
      triggers.delete(key);
    }
  }
}
