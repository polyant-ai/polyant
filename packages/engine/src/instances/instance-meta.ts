// SPDX-License-Identifier: AGPL-3.0-or-later

import type { InstanceMeta } from "../activity-stream/activity-stream.types.js";
import { findInstanceBySlug } from "./store.js";
import { buildInstanceIconUrl } from "./icon-url.js";
import { asInstanceSlug, type InstanceUuid } from "./identifiers.js";
import { TtlCache } from "../utils/ttl-cache.js";

/**
 * Slug → InstanceMeta (id, slug, name, icon URL) with an in-process TTL cache.
 *
 * Every turn needs this more than once: the supervisor needs the agent's UUID,
 * and every model call stamps its activity events with the agent's name and
 * icon. Reading the row each time cost several queries per turn.
 *
 * The entry is dropped whenever the agent's config cache is invalidated
 * (`invalidateInstanceConfigCache`), so a rename or a new icon shows at once.
 * The TTL bounds what an invalidation missed.
 *
 * Failures and unknown slugs return `undefined`. An unknown slug is remembered
 * too (as null), so a caller for whom "unknown" must be authoritative — an
 * agent created a moment ago — reads the row itself on a miss.
 */
const INSTANCE_META_TTL_MS = 60_000;
/** The UUID keeps its brand: it comes from the row, not from the meta's plain `id`. */
interface CachedInstance {
  uuid: InstanceUuid;
  meta: InstanceMeta;
}

const instanceMetaCache = new TtlCache<string, CachedInstance | null>({
  maxSize: 2000,
  ttlMs: INSTANCE_META_TTL_MS,
});

async function resolveCached(slug: string): Promise<CachedInstance | undefined> {
  if (instanceMetaCache.has(slug)) {
    return instanceMetaCache.get(slug) ?? undefined;
  }
  try {
    const inst = await findInstanceBySlug(asInstanceSlug(slug));
    if (!inst) {
      instanceMetaCache.set(slug, null);
      return undefined;
    }
    const entry: CachedInstance = {
      uuid: inst.id,
      meta: {
        id: inst.id,
        slug: inst.slug,
        name: inst.name,
        // Emit a URL, never the raw base64 data URI — see buildInstanceIconUrl.
        icon: buildInstanceIconUrl(inst.slug, inst.icon, inst.updatedAt),
      },
    };
    instanceMetaCache.set(slug, entry);
    return entry;
  } catch {
    return undefined;
  }
}

export async function resolveInstanceMeta(slug?: string): Promise<InstanceMeta | undefined> {
  if (!slug) return undefined;
  return (await resolveCached(slug))?.meta;
}

export async function resolveInstanceUuid(slug: string): Promise<InstanceUuid | undefined> {
  return (await resolveCached(slug))?.uuid;
}

/** Drop one agent's entry; called from `invalidateInstanceConfigCache`. */
export function invalidateInstanceMeta(slug: string): void {
  instanceMetaCache.delete(slug);
}

/** Drop every entry; called from `invalidateAllInstanceConfigCache`. */
export function invalidateAllInstanceMeta(): void {
  instanceMetaCache.clear();
}
