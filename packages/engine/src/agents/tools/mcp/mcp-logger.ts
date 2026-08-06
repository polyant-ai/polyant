// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured logger for the MCP client module.
 * Follows the same pattern as room-logger.ts / webhook-logger.ts: colored,
 * timestamped, prefixed. Output is intercepted by file-logger when installed.
 *
 * Not `console.warn`: these lines interpolate text an external MCP server
 * controls (tool names, error messages), so they are a log-forging vector.
 * `createLogger`'s formatter runs `sanitizeForLog` on the prefix and message
 * INSIDE the chokepoint, which strips the terminators — and, per the note on
 * `sanitizeForLog`, a chokepoint is also the only shape CodeQL's log-injection
 * query accepts as cleared rather than dismissed.
 */

import { createLogger } from "../../../utils/create-logger.js";

export const mcpLog = createLogger();
