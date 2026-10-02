// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "crypto";

/**
 * Short-lived, in-process handoff of a generated binary between two tools of
 * the same conversation.
 *
 * It exists because the producer and the consumer are no longer in the same
 * codebase: a PDF is rendered by one plugin and uploaded by another, and two
 * plugins cannot import each other's module. They exchange a handle instead,
 * and the engine owns the bytes — which is also the only place that can bind
 * the handle to the conversation that produced it.
 *
 * Not a cache and not storage: one `take` consumes the entry, and everything
 * expires. Anything that must outlive the turn belongs in S3 via `fileUpload`.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_STORED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
/**
 * What one binding — one agent's conversation, or one agent's turns without a
 * conversation — may hold at a time. The store is shared by every tenant in
 * the process, so without it one producer (a plugin stuck in a loop, a dev
 * session pushing frames) filled the whole store and every other
 * conversation's handoff failed until the entries expired.
 */
const MAX_ENTRIES_PER_BINDING = 20;
const MAX_BYTES_PER_BINDING = 25 * 1024 * 1024;

export interface ArtifactPayload {
  buffer: Buffer;
  filename: string;
  mime: string;
}

interface ArtifactEntry extends ArtifactPayload {
  /** Who may take it back: see {@link artifactBinding}. */
  binding: string;
  expiresAt: number;
}

/**
 * The key an artifact is bound to: the agent and the conversation that
 * produced it. A turn without a conversation (a scheduled task, a webhook
 * trigger) used to bind to `null` alone, which every such turn of every agent
 * shared, so one agent could take a handle another had produced.
 */
export function artifactBinding(instanceId: string, conversationId: string | null | undefined): string {
  return JSON.stringify([instanceId, conversationId ?? null]);
}

/** What a tool sees as `ctx.artifacts` — already bound to its conversation. */
export interface ArtifactApi {
  /** Store bytes, return the handle to hand to the model. */
  put(payload: ArtifactPayload, ttlMs?: number): string;
  /**
   * Consume a handle. Null when it is unknown, already taken, expired, or was
   * produced in a different conversation — the caller cannot tell which, on
   * purpose: a distinguishable "wrong conversation" answers whether a handle
   * exists.
   */
  take(handle: string): ArtifactPayload | null;
}

export class ArtifactStore {
  private readonly entries = new Map<string, ArtifactEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  put(
    payload: ArtifactPayload,
    binding: string,
    ttlMs: number = DEFAULT_TTL_MS,
  ): string {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_TTL_MS) {
      throw new RangeError("Artifact TTL must be between 1 ms and 10 minutes");
    }
    if (payload.buffer.byteLength > MAX_ARTIFACT_BYTES) {
      throw new RangeError("Artifact exceeds the 10 MB limit");
    }
    this.cleanup();
    let storedBytes = 0;
    let bindingEntries = 0;
    let bindingBytes = 0;
    for (const entry of this.entries.values()) {
      storedBytes += entry.buffer.byteLength;
      if (entry.binding === binding) {
        bindingEntries++;
        bindingBytes += entry.buffer.byteLength;
      }
    }
    if (
      bindingEntries >= MAX_ENTRIES_PER_BINDING ||
      bindingBytes + payload.buffer.byteLength > MAX_BYTES_PER_BINDING
    ) {
      throw new RangeError(
        "This conversation already holds 20 artifacts or 25 MB that nothing has taken; take them or let them expire first",
      );
    }
    if (this.entries.size >= MAX_ENTRIES || storedBytes + payload.buffer.byteLength > MAX_STORED_BYTES) {
      throw new RangeError("Artifact store is full");
    }
    const id = `artifact_${randomUUID()}`;
    this.entries.set(id, { ...payload, binding, expiresAt: Date.now() + ttlMs });
    this.ensureCleanupTimer();
    return id;
  }

  take(handle: string, binding: string): ArtifactPayload | null {
    const entry = this.entries.get(handle);
    if (!entry) return null;
    if (entry.binding !== binding) return null;
    this.entries.delete(handle);
    if (entry.expiresAt < Date.now()) return null;
    const { buffer, filename, mime } = entry;
    return { buffer, filename, mime };
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      (this.cleanupTimer as { unref?: () => void }).unref?.();
    }
  }
}

export const artifactStore = new ArtifactStore();

/** Bind the process-wide store to one agent's conversation for one tool's `ctx`. */
export function artifactApiFor(instanceId: string, conversationId: string | null | undefined): ArtifactApi {
  const binding = artifactBinding(instanceId, conversationId);
  return {
    put: (payload, ttlMs) => artifactStore.put(payload, binding, ttlMs),
    take: (handle) => artifactStore.take(handle, binding),
  };
}
