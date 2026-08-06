// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured logger for the A2A inbound server module.
 * Same pattern as mcp-logger.ts / room-logger.ts / webhook-logger.ts: colored,
 * timestamped, prefixed. Output is intercepted by file-logger when installed.
 *
 * Not `console.warn`: these lines interpolate text an external A2A client
 * controls (task ids, agent slugs, error messages), so they are a log-forging
 * vector. `createLogger`'s formatter runs `sanitizeForLog` on the prefix and
 * message INSIDE the chokepoint, which strips the terminators.
 */

import { createLogger } from "../../utils/create-logger.js";

export const a2aLog = createLogger();
