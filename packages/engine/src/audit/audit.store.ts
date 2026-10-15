// SPDX-License-Identifier: AGPL-3.0-or-later

import { toolAuditLogs } from "./audit.schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { BufferedInsertQueue, type InsertableDb } from "../utils/buffered-insert-queue.js";

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

/** `toolAuditLogs.action` is `varchar(100) NOT NULL`: both limits are enforced here. */
const ACTION_MAX_LEN = 100;

class AuditStore {
  // A refused row is dropped only when its neighbours were written (see BufferedInsertQueue).
  private readonly queue = new BufferedInsertQueue<AuditEntry>({
    table: toolAuditLogs,
    label: "audit entries",
    onRefused: (rows, written) =>
      console.warn(
        `AuditStore: dropped ${rows.length} un-insertable audit entries ` +
          `(actions: ${[...new Set(rows.map((e) => e.action))].join(", ")}); ` +
          `${written} entries in the same batch were written.`,
      ),
  });

  initialize(db: InsertableDb) {
    this.queue.initialize(db);
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
    this.queue.push(
      entry.action.length > ACTION_MAX_LEN
        ? { ...entry, action: entry.action.slice(0, ACTION_MAX_LEN) }
        : entry,
    );
  }

  /** Patch durationMs on the most recent buffered entry for a given tool+instance. */
  patchDuration(toolName: string, instanceId: InstanceSlug, durationMs: number) {
    const e = this.queue.findLast(
      (e) => e.toolName === toolName && e.instanceId === instanceId && e.durationMs == null,
    );
    if (e) e.durationMs = durationMs;
  }

  /** Patch output preview on the most recent buffered entry for a given tool+instance. */
  patchOutput(toolName: string, instanceId: InstanceSlug, output: string) {
    const e = this.queue.findLast(
      (e) => e.toolName === toolName && e.instanceId === instanceId && e.output == null,
    );
    if (e) e.output = output;
  }

  flush() {
    return this.queue.flush();
  }

  shutdown() {
    return this.queue.shutdown();
  }
}

export const auditStore = new AuditStore();
