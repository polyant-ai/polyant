// SPDX-License-Identifier: AGPL-3.0-or-later

import { TtlCache } from "../utils/ttl-cache.js";

/**
 * Provider delivery ids seen recently, so a redelivered webhook is dropped
 * instead of answered twice.
 *
 * Telegram resends an update until its webhook answers 200, and Slack retries
 * an event (`X-Slack-Retry-Num`) that was not acknowledged in time; a signed
 * request can also be replayed inside the signature's 300 s window. Each would
 * run the agent again, and the contact would get a second reply.
 *
 * In memory, per process. The webhooks acknowledge before the turn runs, which
 * removes the usual cause of a redelivery (a slow 200), so what remains is the
 * rare retry after a lost response. With several replicas that retry can land
 * on another one, which then processes it again; a deployment that cannot
 * accept that runs one replica (see docs/UPGRADING.md). A shared table would
 * close the gap at the cost of a database write on every inbound message.
 *
 * The window outlasts Slack's retry schedule (about five minutes) and the
 * signature window with room to spare.
 */
const seen = new TtlCache<string, true>({ maxSize: 50_000, ttlMs: 60 * 60_000 });

/** True the first time `key` is seen inside the window; false for a redelivery. */
export function firstDelivery(key: string): boolean {
  if (seen.has(key)) return false;
  seen.set(key, true);
  return true;
}

/** Forget every delivery. Tests only. */
export function resetInboundDedupe(): void {
  seen.clear();
}
