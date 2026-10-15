// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Generic in-memory TTL cache with bounded size
// ---------------------------------------------------------------------------

export interface TtlCacheOptions {
  /** Maximum number of entries before stale eviction is triggered. */
  maxSize: number;
  /** Time-to-live in milliseconds for each entry. */
  ttlMs: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Simple in-memory cache with per-entry TTL and bounded size.
 *
 * - `get` returns `undefined` for expired entries (lazy eviction).
 * - When `maxSize` is exceeded after a `set`, all expired entries are purged.
 * - A periodic sweep runs every 60 s to remove stale entries even when the
 *   cache is not actively read.
 */
export class TtlCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TtlCacheOptions) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;

    // Periodic background sweep (unref'd so it doesn't keep the process alive)
    this.sweepTimer = setInterval(() => this.evictExpired(), 60_000);
    if (this.sweepTimer && typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }
  }

  /** Check whether a non-expired entry exists for `key`. */
  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /** Retrieve a value. Returns `undefined` if missing or expired. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a value with the configured TTL. Triggers eviction if over capacity. */
  set(key: K, value: V): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > this.maxSize) {
      this.evictExpired();
      // Fall back to oldest-first eviction when nothing expired: Map insertion
      // order guarantees `keys().next()` is the oldest entry.
      while (this.map.size > this.maxSize) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.map.delete(oldest);
      }
    }
  }

  /** Remove a single entry. */
  delete(key: K): void {
    this.map.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /** Stop the background sweep timer (for graceful shutdown). */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  // -- internal ---------------------------------------------------------------

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
  }
}

/**
 * A single-value cache that holds the PROMISE, so concurrent callers that miss
 * share one fetch instead of each starting their own. A rejection clears the
 * entry, so a failed read is retried instead of being served for `ttlMs`.
 */
export function cachedValue<T>(
  fetch: () => Promise<T>,
  ttlMs: number,
): { get(): Promise<T>; invalidate(): void } {
  let entry: { at: number; value: Promise<T> } | null = null;
  return {
    get() {
      if (entry && Date.now() - entry.at < ttlMs) return entry.value;
      // Stored BEFORE awaiting, so a caller arriving mid-flight joins this read.
      const mine: { at: number; value: Promise<T> } = {
        at: Date.now(),
        value: fetch().catch((err: unknown) => {
          if (entry === mine) entry = null;
          throw err;
        }),
      };
      entry = mine;
      return mine.value;
    },
    invalidate() {
      entry = null;
    },
  };
}
