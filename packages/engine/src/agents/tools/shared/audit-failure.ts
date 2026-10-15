// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AuditLogger } from "../../../audit/audit-logger.js";
import { errMsg } from "../../../utils/error.js";
import { createLogger } from "../../../utils/create-logger.js";

const toolLog = createLogger();

/**
 * The failure epilogue of a built-in tool: record the failed call on the audit
 * trail and, when `logLabel` is given, log it to the console. Returns the
 * message for the tool to put in its result.
 */
export function auditFailure(
  tool: { audit: Pick<AuditLogger, "log"> },
  action: string,
  details: Record<string, unknown> | undefined,
  err: unknown,
  logLabel?: string,
): string {
  const message = errMsg(err);
  // Through the logger, which sanitizes the line and is the repo's logging chokepoint.
  if (logLabel) toolLog.error(logLabel, "error", err);
  tool.audit.log({ action, ...(details ? { details } : {}), success: false, error: message });
  return message;
}
