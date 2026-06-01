// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface PdfEntry {
  buffer: Buffer;
  filename: string;
  mime: string;
  expiresAt: number;
}

class PdfHandleStore {
  private readonly entries = new Map<string, PdfEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  put(buffer: Buffer, filename: string, mime: string, ttlMs: number = DEFAULT_TTL_MS): string {
    const id = `pdf_${randomUUID()}`;
    this.entries.set(id, {
      buffer,
      filename,
      mime,
      expiresAt: Date.now() + ttlMs,
    });
    this.ensureCleanupTimer();
    return id;
  }

  take(handleId: string): PdfEntry | null {
    const entry = this.entries.get(handleId);
    if (!entry) return null;
    this.entries.delete(handleId);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
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

export const pdfHandleStore = new PdfHandleStore();
