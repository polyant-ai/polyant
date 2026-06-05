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
import type { FeedEvent, InstanceMeta } from "./activity-stream.types.js";
import { findInstanceBySlug } from "../instances/store.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { TtlCache } from "../utils/ttl-cache.js";

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

/**
 * Slug → InstanceMeta lookup with a small in-process TTL cache. Intended for
 * the per-category emitters that don't sit on a hot path but get called
 * repeatedly with the same slug (e.g. scheduled-task fires, webhooks,
 * inbound channel adapters).
 *
 * Failures and unknown slugs return `undefined` — the emitter then drops the
 * `instance` field, the FE falls back to its "unknown agent" label.
 */
const INSTANCE_META_TTL_MS = 60_000;
const instanceMetaCache = new TtlCache<string, InstanceMeta | null>({
  maxSize: 200,
  ttlMs: INSTANCE_META_TTL_MS,
});

export async function resolveInstanceMeta(slug?: string): Promise<InstanceMeta | undefined> {
  if (!slug) return undefined;
  if (instanceMetaCache.has(slug)) {
    const cached = instanceMetaCache.get(slug);
    return cached ?? undefined;
  }
  try {
    const inst = await findInstanceBySlug(asInstanceSlug(slug));
    if (!inst) {
      instanceMetaCache.set(slug, null);
      return undefined;
    }
    const meta: InstanceMeta = {
      id: inst.id,
      slug: inst.slug,
      name: inst.name,
      icon: inst.icon ?? null,
    };
    instanceMetaCache.set(slug, meta);
    return meta;
  } catch {
    return undefined;
  }
}
