// SPDX-License-Identifier: AGPL-3.0-or-later

import { toolAuditLogs } from "./audit.schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";

export interface AuditEntry {
  instanceId: InstanceSlug;
  conversationId?: string;
  toolName: string;
  action: string;
  details?: Record<string, unknown>;
  success?: boolean;
  error?: string;
  durationMs?: number;
  output?: string;
}

/** Minimal DB interface for insert operations. */
interface InsertableDb {
  insert(table: unknown): { values(v: unknown): Promise<unknown> };
}

class AuditStore {
  private static readonly MAX_BUFFER_SIZE = 500;
  private buffer: AuditEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private db: InsertableDb | null = null;

  initialize(db: InsertableDb) {
    this.db = db;
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  record(entry: AuditEntry) {
    this.buffer.push(entry);
    if (this.buffer.length >= 10) {
      this.flush();
    }
  }

  /** Patch durationMs on the most recent buffered entry for a given tool+instance. */
  patchDuration(toolName: string, instanceId: InstanceSlug, durationMs: number) {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const e = this.buffer[i];
      if (e.toolName === toolName && e.instanceId === instanceId && e.durationMs == null) {
        e.durationMs = durationMs;
        return;
      }
    }
  }

  /** Patch output preview on the most recent buffered entry for a given tool+instance. */
  patchOutput(toolName: string, instanceId: InstanceSlug, output: string) {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const e = this.buffer[i];
      if (e.toolName === toolName && e.instanceId === instanceId && e.output == null) {
        e.output = output;
        return;
      }
    }
  }

  async flush() {
    if (this.buffer.length === 0 || !this.db) return;

    const entries = [...this.buffer];
    this.buffer = [];

    try {
      await this.db.insert(toolAuditLogs).values(entries);
    } catch (err) {
      console.error("Failed to flush audit logs:", err);
      // Re-add failed entries, but cap buffer to prevent memory leak
      this.buffer.unshift(...entries);
      if (this.buffer.length > AuditStore.MAX_BUFFER_SIZE) {
        const dropped = this.buffer.length - AuditStore.MAX_BUFFER_SIZE;
        this.buffer = this.buffer.slice(-AuditStore.MAX_BUFFER_SIZE);
        console.warn(`AuditStore: dropped ${dropped} oldest audit entries, keeping newest (buffer full)`);
      }
    }
  }

  async shutdown() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
}

export const auditStore = new AuditStore();
