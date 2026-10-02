// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared helpers used by every per-category emitter under `emitters/`.
 *
 * Kept tiny on purpose: emitters should be one focused function each, with
 * any shared boilerplate (id generation, error-safe emit, timestamps)
 * factored here so we don't sprinkle try/catch across every call site.
 */

import { randomUUID } from "node:crypto";
import { activityBus } from "./activity-bus.js";
import type { FeedEvent } from "./activity-stream.types.js";

/** Wrap emit so listener errors never bubble back to the producer. */
export function safeEmit(evt: FeedEvent): void {
  try {
    activityBus.emitEvent(evt);
  } catch {
    // Listener mis-behaved; drop. Activity bus is purely best-effort.
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a unique event id for a single-shot emitter (inbound, outbound,
 * webhook, cron, memory, conversation).
 *
 * `category` is included so events from different sources are easy to
 * spot in logs / debugging without parsing the rest of the payload.
 */
export function makeEventId(category: string, scopeId?: string): string {
  const scope = scopeId ?? "anon";
  return `${category}:${scope}:${randomUUID().slice(0, 8)}`;
}

/** Lives with the agent's other caches, which invalidate it; re-exported for the emitters. */
export { resolveInstanceMeta } from "../instances/instance-meta.js";
