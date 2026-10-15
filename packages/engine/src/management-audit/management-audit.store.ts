// SPDX-License-Identifier: AGPL-3.0-or-later

import { managementAuditLogs } from "./management-audit.schema.js";
import { BufferedInsertQueue, type InsertableDb } from "../utils/buffered-insert-queue.js";

/** A single row to be persisted to `management_audit_logs`. */
export interface ManagementAuditEntry {
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Buffered writer for the OSS management write-audit log. Batches on size or interval and never
 * loses the audit trail on a transient DB error (see BufferedInsertQueue).
 */
export class ManagementAuditStore {
  private readonly queue = new BufferedInsertQueue<ManagementAuditEntry>({
    table: managementAuditLogs,
    label: "management audit logs",
    onRefused: (rows) => {
      for (const entry of rows) {
        console.error(
          `ManagementAuditStore: dropped an audit entry the database refused (action ${entry.action}, target type ${entry.targetType})`,
        );
      }
    },
  });

  initialize(db: InsertableDb): void {
    this.queue.initialize(db);
  }

  record(entry: ManagementAuditEntry): void {
    this.queue.push(fitColumns(entry));
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  shutdown(): Promise<void> {
    return this.queue.shutdown();
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
