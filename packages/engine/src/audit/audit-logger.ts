// SPDX-License-Identifier: AGPL-3.0-or-later

import { auditStore } from "./audit.store.js";
import { type InstanceSlug } from "../instances/identifiers.js";

/** Tool-facing audit API. Each tool receives its own logger instance. */
export interface AuditLogger {
  log(entry: {
    action: string;
    details?: Record<string, unknown>;
    success?: boolean;
    error?: string;
    durationMs?: number;
    output?: string;
  }): void;
}

/** Create an AuditLogger scoped to a specific tool + instance + conversation. */
export function createAuditLogger(
  toolName: string,
  instanceId: InstanceSlug,
  conversationId?: string,
): AuditLogger {
  return {
    log({ action, details, success, error, durationMs, output }) {
      auditStore.record({
        toolName,
        instanceId,
        conversationId,
        action,
        details,
        success: success ?? true,
        error,
        durationMs,
        output,
      });
    },
  };
}

/** Truncate a string for safe audit logging (no secrets, bounded size). */
export function auditPreview(text: string, maxLen = 100): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
