// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OptoutAction, OptoutConfig, OptoutStatus } from "./optout.types.js";

function matches(keywords: string[], normalized: string): boolean {
  return keywords.some((k) => k.trim().toLowerCase() === normalized);
}

/**
 * Pure decision function for the opt-out inbound gate. No I/O.
 *
 * Precedence: when already opted out, a resume keyword wins (re-enable) and
 * everything else (including a repeated stop keyword) is silent. When subscribed,
 * a stop keyword opts out and everything else (including a resume keyword) passes.
 */
export function evaluateOptout(input: {
  config: OptoutConfig;
  currentStatus: OptoutStatus;
  messageText: string;
}): OptoutAction {
  const { config, currentStatus, messageText } = input;
  if (!config.enabled) return { kind: "pass" };

  const normalized = messageText.trim().toLowerCase();

  if (currentStatus === "opted_out") {
    if (matches(config.resumeKeywords, normalized)) {
      return { kind: "resume", reply: config.resumeMessage ?? null };
    }
    return { kind: "blocked_silent" };
  }

  // currentStatus === "opted_in"
  if (matches(config.stopKeywords, normalized)) {
    return { kind: "stop", reply: config.closingMessage ?? null };
  }
  return { kind: "pass" };
}
