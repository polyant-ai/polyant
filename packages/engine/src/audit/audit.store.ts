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

/** `toolAuditLogs.action` is `varchar(100) NOT NULL`: both limits are enforced here. */
const ACTION_MAX_LEN = 100;

class AuditStore {
  private static readonly MAX_BUFFER_SIZE = 500;
  private buffer: AuditEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private db: InsertableDb | null = null;

  initialize(db: InsertableDb) {
    this.db = db;
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  /**
   * Buffer one entry — after checking the one field that can poison everyone else's.
   *
   * `action` is `varchar(100) NOT NULL`. An entry that violates either constraint cannot be
   * inserted, and because `flush()` writes the whole buffer in ONE statement, it does not fail
   * alone: it fails the batch, which is then re-queued and retried every 5 seconds. The
   * observed consequence was that a single plugin calling `log()` with the wrong signature
   * (`log("action", {...})`, so `action` arrived `undefined`) stopped audit persistence for
   * EVERY tool on that instance, while printing one error every 5 seconds.
   *
   * So the check happens at the door, where the caller is still known and can be named in the
   * warning. A missing `action` is dropped — an entry that can never be inserted has exactly
   * one possible future, and losing that one row is strictly better than losing everyone's. An
   * over-long `action` is truncated instead of dropped: the row still carries its meaning.
   */
  record(entry: AuditEntry) {
    if (typeof entry.action !== "string" || entry.action.trim() === "") {
      console.warn(
        `AuditStore: dropped an entry without \`action\` from tool="${entry.toolName}" ` +
          `instance="${entry.instanceId}". \`log()\` takes ONE object: ` +
          `log({ action, details?, success?, error? }).`,
      );
      return;
    }
    this.buffer.push(
      entry.action.length > ACTION_MAX_LEN
        ? { ...entry, action: entry.action.slice(0, ACTION_MAX_LEN) }
        : entry,
    );
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
      return;
    } catch (err) {
      console.error("Failed to flush audit logs:", err);
    }

    /**
     * The batch failed. Insert row by row to tell "one bad row" from "the database is down" —
     * because the two need opposite handling and, written as one `catch` that re-queues
     * everything, they got the same one.
     *
     * A bad row re-queued is a bad row retried forever: it fails the batch again on the next
     * tick, and every well-formed entry behind it never reaches the table. That is how audit
     * persistence disappeared for a whole instance because of a single malformed entry.
     *
     * If EVERY row fails individually the cause is not the rows — it is the database, or the
     * connection — and nothing is discarded: the buffer keeps them for the next tick, which is
     * the original behaviour and the right one. Rows are dropped only when their neighbours
     * went in, which is what makes them poison rather than unlucky.
     */
    const rejected: AuditEntry[] = [];
    let written = 0;
    for (const entry of entries) {
      try {
        await this.db.insert(toolAuditLogs).values([entry]);
        written++;
      } catch {
        rejected.push(entry);
      }
    }

    if (written === 0) {
      // Nothing went in: treat it as transient and keep every entry.
      this.buffer.unshift(...entries);
    } else if (rejected.length > 0) {
      console.warn(
        `AuditStore: dropped ${rejected.length} un-insertable audit entries ` +
          `(actions: ${[...new Set(rejected.map((e) => e.action))].join(", ")}); ` +
          `${written} entries in the same batch were written.`,
      );
    }

    if (this.buffer.length > AuditStore.MAX_BUFFER_SIZE) {
      const dropped = this.buffer.length - AuditStore.MAX_BUFFER_SIZE;
      this.buffer = this.buffer.slice(-AuditStore.MAX_BUFFER_SIZE);
      console.warn(`AuditStore: dropped ${dropped} oldest audit entries, keeping newest (buffer full)`);
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
