// SPDX-License-Identifier: AGPL-3.0-or-later

import { resetStuckProcessingAll } from "./store.js";

/** How often the recovery runs after boot. */
export const STUCK_DOCUMENT_SWEEP_MS = 5 * 60_000;

async function sweepOnce(): Promise<void> {
  try {
    const reset = await resetStuckProcessingAll();
    if (reset > 0) {
      console.log(`[Knowledge] Reset ${reset} stalled document(s) to error`);
    }
  } catch (err) {
    console.error(
      "[Knowledge] Stalled-document recovery failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Fail abandoned ingestions at boot and then periodically.
 *
 * Boot alone was not enough: a process that died seconds after accepting an
 * upload and came straight back found the row too recent to call abandoned,
 * and no later check ever looked again. Returns the function that stops it.
 */
export async function startStuckDocumentSweep(intervalMs = STUCK_DOCUMENT_SWEEP_MS): Promise<() => void> {
  await sweepOnce();
  const timer = setInterval(() => void sweepOnce(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
