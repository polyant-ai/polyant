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

export interface ArtifactPayload {
  buffer: Buffer;
  filename: string;
  mime: string;
}

interface ArtifactEntry extends ArtifactPayload {
  /** The conversation that produced it, or null when the turn had none. */
  conversationId: string | null;
  expiresAt: number;
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
    conversationId: string | null,
    ttlMs: number = DEFAULT_TTL_MS,
  ): string {
    const id = `artifact_${randomUUID()}`;
    this.entries.set(id, { ...payload, conversationId, expiresAt: Date.now() + ttlMs });
    this.ensureCleanupTimer();
    return id;
  }

  take(handle: string, conversationId: string | null): ArtifactPayload | null {
    const entry = this.entries.get(handle);
    if (!entry) return null;
    if (entry.conversationId !== conversationId) return null;
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

/** Bind the process-wide store to one conversation for one tool's `ctx`. */
export function artifactApiFor(conversationId: string | null): ArtifactApi {
  return {
    put: (payload, ttlMs) => artifactStore.put(payload, conversationId, ttlMs),
    take: (handle) => artifactStore.take(handle, conversationId),
  };
}
