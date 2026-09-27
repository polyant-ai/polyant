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
    this.buffer.push(fitColumns(entry));
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
      // One row the database refuses fails the whole multi-row INSERT. Retried
      // as a batch, it would keep failing every later flush, so no tenant's
      // audit reached the table until the buffer cap pushed it out. Row by
      // row, the refused rows are dropped and the rest are written; only when
      // every row fails is it the database, and the batch is kept for later.
      if (entries.length > 1 && await this.insertEachDroppingRefused(entries)) return;
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

  /** True when at least one row was written; refused rows are dropped. */
  private async insertEachDroppingRefused(entries: ManagementAuditEntry[]): Promise<boolean> {
    const refused: ManagementAuditEntry[] = [];
    for (const entry of entries) {
      try {
        await this.db!.insert(managementAuditLogs).values([entry]);
      } catch {
        refused.push(entry);
      }
    }
    if (refused.length === entries.length) return false;
    for (const entry of refused) {
      console.error(
        `ManagementAuditStore: dropped an audit entry the database refused (action ${entry.action}, target type ${entry.targetType})`,
      );
    }
    return true;
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

/**
 * Column widths of `management_audit_logs`. A caller-supplied value longer than
 * its column (a target id built from a request field, say) would make the row
 * unwritable; cut to the width, the row still records who did what.
 */
const COLUMN_WIDTH = { action: 100, actorEmail: 255, targetType: 50, targetId: 255 } as const;

function fitColumns(entry: ManagementAuditEntry): ManagementAuditEntry {
  return {
    ...entry,
    action: entry.action.slice(0, COLUMN_WIDTH.action),
    actorEmail: entry.actorEmail?.slice(0, COLUMN_WIDTH.actorEmail) ?? entry.actorEmail,
    targetType: entry.targetType.slice(0, COLUMN_WIDTH.targetType),
    targetId: entry.targetId.slice(0, COLUMN_WIDTH.targetId),
  };
}
