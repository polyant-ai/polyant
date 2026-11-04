// SPDX-License-Identifier: AGPL-3.0-or-later

import { AsyncLocalStorage } from "node:async_hooks";
import { toolAuditLogs } from "./audit.schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { BufferedInsertQueue, type InsertableDb } from "../utils/buffered-insert-queue.js";
import { createLogger } from "../utils/create-logger.js";

const log = createLogger();

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

/** A buffered row: the entry plus the moment it was recorded, which is the row's `created_at`. */
type AuditRow = AuditEntry & { createdAt: Date };

/**
 * One tool call in progress. The rows its tool records are held here and written when the call
 * ends, carrying that call's duration and output. Matching rows to calls by tool and agent after
 * the fact gave one conversation's output to another's row.
 */
interface ToolCall {
  toolName: string;
  instanceId: InstanceSlug;
  rows: AuditRow[];
  ended: boolean;
}

const currentToolCall = new AsyncLocalStorage<ToolCall>();

/** `toolAuditLogs.action` is `varchar(100) NOT NULL`: both limits are enforced here. */
const ACTION_MAX_LEN = 100;

class AuditStore {
  // A row is dropped only when the database refused its data (see BufferedInsertQueue).
  private readonly queue = new BufferedInsertQueue<AuditRow>({
    table: toolAuditLogs,
    label: "audit entries",
    onRefused: (rows, written) =>
      log.error(
        "audit",
        `dropped ${rows.length} un-insertable audit entries ` +
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
      log.warn(
        "audit",
        `dropped an entry without \`action\` from tool="${entry.toolName}" ` +
          `instance="${entry.instanceId}". \`log()\` takes ONE object: ` +
          `log({ action, details?, success?, error? }).`,
      );
      return;
    }
    const row: AuditRow = {
      ...entry,
      action: entry.action.slice(0, ACTION_MAX_LEN),
      createdAt: new Date(),
    };
    const call = currentToolCall.getStore();
    if (call && !call.ended && call.toolName === row.toolName && call.instanceId === row.instanceId) {
      call.rows.push(row);
      return;
    }
    this.queue.push(row);
  }

  /**
   * Run one tool call. The rows its tool records while it runs are written when `end` is called,
   * the last of them with the call's `durationMs` and `output` unless the tool set its own. A row
   * recorded after `end` (work the tool left running) is written as it is.
   */
  beginToolCall(toolName: string, instanceId: InstanceSlug) {
    const call: ToolCall = { toolName, instanceId, rows: [], ended: false };
    return {
      run: <T>(execute: () => Promise<T>): Promise<T> => currentToolCall.run(call, execute),
      end: (durationMs: number, output?: string) => {
        if (call.ended) return;
        call.ended = true;
        const last = call.rows.at(-1);
        if (last) {
          last.durationMs ??= durationMs;
          if (output !== undefined) last.output ??= output;
        }
        for (const row of call.rows) this.queue.push(row);
      },
    };
  }

  flush() {
    return this.queue.flush();
  }

  shutdown() {
    return this.queue.shutdown();
  }
}

export const auditStore = new AuditStore();
