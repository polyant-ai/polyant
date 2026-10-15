// SPDX-License-Identifier: AGPL-3.0-or-later

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface TriggerEntry {
  conversationId: string;
  expiresAt: number;
}

const triggers = new Map<string, TriggerEntry>();

function buildKey(instanceId: string, channelType: string, channelId: string): string {
  return `${instanceId}:${channelType}:${channelId}`;
}

export function registerTrigger(
  instanceId: string,
  channelType: string,
  channelId: string,
  conversationId: string,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  // Entries for contacts who never reply are never read again, so expired ones are swept on write.
  clearExpiredTriggers();
  const key = buildKey(instanceId, channelType, channelId);
  triggers.set(key, {
    conversationId,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getActiveTrigger(
  instanceId: string,
  channelType: string,
  channelId: string,
): string | null {
  const key = buildKey(instanceId, channelType, channelId);
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

/** Number of stored triggers, expired or not. Exposed for tests. */
export function activeTriggerCount(): number {
  return triggers.size;
}
