// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * In-process signal that a conversation's stored transcript changed.
 *
 * Raised after a message or hook-execution write commits, so a subscriber that
 * re-reads the conversation on this signal sees the new rows. It carries only
 * the conversation id: readers fetch through the normal, tenant-checked read
 * paths instead of trusting a payload.
 *
 * Single-engine, like the activity bus: a write handled by another replica does
 * not reach subscribers connected here.
 */

import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** Announce a committed write. Never throws back into the writer. */
export function notifyConversationChanged(conversationId: string): void {
  try {
    emitter.emit(conversationId);
  } catch {
    // A misbehaving listener must not fail the write that already committed.
  }
}

/** Listen for committed writes to one conversation. Returns the unsubscribe. */
export function subscribeConversationChanges(conversationId: string, listener: () => void): () => void {
  emitter.on(conversationId, listener);
  return () => {
    emitter.off(conversationId, listener);
  };
}
