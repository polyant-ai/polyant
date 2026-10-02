// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Work the engine has already acknowledged to the sender and is still doing.
 *
 * The Telegram, Slack and Twilio webhooks, and the generic event webhook,
 * answer 200 first and run the turn afterwards, so the sender does not deliver
 * the same message again. Once acknowledged, the sender will not retry: a turn
 * that the shutdown sequence cuts off is lost. The HTTP server's grace period
 * waits only for open requests, which these turns no longer are, so shutdown
 * waits for the work registered here as well.
 */
const pending = new Set<Promise<unknown>>();

/**
 * Register acknowledged work. The caller keeps handling its own errors; a
 * rejection here only ends the tracking.
 */
export function trackBackgroundTurn(work: Promise<unknown>): void {
  const tracked = work.then(
    () => undefined,
    () => undefined,
  );
  pending.add(tracked);
  void tracked.then(() => pending.delete(tracked));
}

/** How much acknowledged work is still running. */
export function pendingBackgroundTurns(): number {
  return pending.size;
}

/**
 * Wait until no acknowledged work is running, or `timeoutMs` has passed.
 * Work registered while waiting (a request still in flight that acknowledges
 * during shutdown) is waited for too. Returns how much was still running.
 */
export async function drainBackgroundTurns(timeoutMs: number): Promise<{ pending: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    while (pending.size > 0) {
      const outcome = await Promise.race([Promise.all([...pending]), deadline]);
      if (outcome === "timeout") break;
    }
  } finally {
    clearTimeout(timer);
  }
  return { pending: pending.size };
}
