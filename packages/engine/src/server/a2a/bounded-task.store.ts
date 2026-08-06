// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveUserScope, type TaskStore } from "@a2a-js/sdk/server";
import type { ServerCallContext } from "@a2a-js/sdk/server";
import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";

/** Maximum number of retained tasks across all tenants/owners/slugs. */
export const MAX_TASKS = 500;
/** Retention window for a stored task. Tasks are ephemeral (single-turn pipeline). */
export const TASK_TTL_MS = 10 * 60_000;
/** SDK default / maximum page size for `list`. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface Entry {
  task: Task;
  expiresAt: number;
}

/**
 * A size- and TTL-bounded {@link TaskStore}.
 *
 * The SDK's `InMemoryTaskStore` never evicts: `DefaultRequestHandler` saves
 * every task WITH its message history, so an (optionally unauthenticated) A2A
 * caller could grow the engine heap one task per request until OOM. This store
 * mirrors the idiom of `utils/ttl-cache.ts` (lazy per-read expiry + a periodic
 * sweep + oldest-first eviction over `maxSize`), but keeps its own Map because
 * `list()` needs to iterate entries, which `TtlCache` does not expose.
 *
 * Scoping matches the SDK: `tenant` from the call context, owner from an
 * {@link resolveUserScope}-shaped resolver, so a caller only ever loads or
 * lists its own tasks.
 */
export class BoundedTaskStore implements TaskStore {
  private readonly entries = new Map<string, Entry>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly maxSize: number = MAX_TASKS,
    private readonly ttlMs: number = TASK_TTL_MS,
    private readonly ownerResolver: (context: ServerCallContext) => string = resolveUserScope,
  ) {
    this.sweepTimer = setInterval(() => this.evictExpired(), 60_000);
    if (this.sweepTimer && typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    this.entries.set(this.keyOf(task.id, context), { task, expiresAt: Date.now() + this.ttlMs });
    if (this.entries.size > this.maxSize) {
      this.evictExpired();
      // Fall back to oldest-first eviction: Map insertion order guarantees
      // `keys().next()` is the oldest entry.
      while (this.entries.size > this.maxSize) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const key = this.keyOf(taskId, context);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.task;
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    this.evictExpired();
    const prefix = this.scopePrefix(context);
    const matched: Task[] = [];
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      if (params.contextId && entry.task.contextId !== params.contextId) continue;
      if (params.status && entry.task.status?.state !== params.status) continue;
      matched.push(entry.task);
    }
    const pageSize = Math.min(Math.max(params.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    return {
      tasks: matched.slice(0, pageSize),
      // Pagination is not supported by this bounded store: the retained window
      // is at most `maxSize` ephemeral tasks, so a single page always suffices.
      nextPageToken: "",
      pageSize,
      totalSize: matched.length,
    };
  }

  /** Number of currently retained (not lazily expired) entries — for tests/diagnostics. */
  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /** Stop the background sweep timer (for graceful shutdown). */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  // -- internal ---------------------------------------------------------------

  /** NUL cannot appear in a tenant/owner/task id, so the key is unambiguous. */
  private scopePrefix(context: ServerCallContext): string {
    return `${context.tenant ?? ""}\u0000${this.ownerResolver(context)}\u0000`;
  }

  private keyOf(taskId: string, context: ServerCallContext): string {
    return `${this.scopePrefix(context)}${taskId}`;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) this.entries.delete(k);
    }
  }
}
