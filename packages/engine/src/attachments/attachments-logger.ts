// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured logger for attachment storage. Same pattern as memory-logger.ts /
 * room-logger.ts: colored, timestamped, prefixed, and intercepted by
 * file-logger when installed.
 *
 * Used rather than a bare `console.warn` for a second reason here: the message
 * carries an agent SLUG, which arrives from a request, and `createLogger`'s
 * `fmt` runs `sanitizeForLog` over both the prefix and the message. A raw
 * template literal would let a slug carrying a newline forge a log line — and
 * it is also the one shape CodeQL's log-injection query accepts as clean.
 */

import { createLogger } from "../utils/create-logger.js";

export const attachmentsLog = createLogger();
