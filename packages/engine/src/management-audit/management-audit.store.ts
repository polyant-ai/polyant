// SPDX-License-Identifier: AGPL-3.0-or-later

import { managementAuditLogs } from "./management-audit.schema.js";

/** A single row to be persisted to `management_audit_logs`. */
export interface ManagementAuditEntry {
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/** Minimal DB interface for insert operations (the shared `db` satisfies it). */
interface InsertableDb {
  insert(table: unknown): { values(v: unknown): Promise<unknown> };
}

/**
 * Buffered writer for the OSS management write-audit log. Mirrors the AI-runtime
 * `AuditStore` flush/back-pressure semantics: batch on size or interval, never
 * lose the audit trail on a transient DB error (re-buffer, capped).
 */
export class ManagementAuditStore {
  private static readonly FLUSH_THRESHOLD = 10;
  private static readonly MAX_BUFFER_SIZE = 500;
  private static readonly FLUSH_INTERVAL_MS = 5000;

  private buffer: ManagementAuditEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private db: InsertableDb | null = null;

  initialize(db: InsertableDb): void {
    this.db = db;
    this.flushInterval = setInterval(() => {
      void this.flush();
    }, ManagementAuditStore.FLUSH_INTERVAL_MS);
  }

  record(entry: ManagementAuditEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= ManagementAuditStore.FLUSH_THRESHOLD) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.db) return;

    const entries = [...this.buffer];
    this.buffer = [];

    try {
      await this.db.insert(managementAuditLogs).values(entries);
    } catch (err) {
      console.error("Failed to flush management audit logs:", err);
      // Re-buffer failed entries, but cap to prevent an unbounded memory leak.
      this.buffer.unshift(...entries);
      if (this.buffer.length > ManagementAuditStore.MAX_BUFFER_SIZE) {
        const dropped = this.buffer.length - ManagementAuditStore.MAX_BUFFER_SIZE;
        this.buffer = this.buffer.slice(-ManagementAuditStore.MAX_BUFFER_SIZE);
        console.warn(
          `ManagementAuditStore: dropped ${dropped} oldest audit entries, keeping newest (buffer full)`,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }
}

/** Process-wide singleton, initialized at boot. */
export const managementAuditStore = new ManagementAuditStore();
