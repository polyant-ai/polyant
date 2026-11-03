// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Work the engine has already started on its own and is still doing.
 *
 * The Telegram, Slack and Twilio webhooks, and the generic event webhook,
 * answer 200 first and run the turn afterwards, so the sender does not deliver
 * the same message again. Once acknowledged, the sender will not retry: a turn
 * that the shutdown sequence cuts off is lost. A Room cycle and a scheduled-task
 * run are the same kind of work: no request waits on them, and cutting one off
 * throws away a model call already paid for. The HTTP server's grace period
 * waits only for open requests, so shutdown waits for the work registered here
 * as well, and for the post-response work of turns already answered
 * ({@link runBackgroundJob}).
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

/**
 * How many background jobs run at once. The post-response work of a turn (its
 * title, its summary, its memory extraction) is up to three model calls and a
 * run of database transactions; under load, unbounded, it competed with the
 * turns themselves for the connection pool.
 */
export const MAX_CONCURRENT_BACKGROUND_JOBS = 4;

const queued: Array<() => void> = [];
let runningJobs = 0;

/**
 * Run work the engine owes after a turn has been answered: queued behind at
 * most {@link MAX_CONCURRENT_BACKGROUND_JOBS} others, and tracked from the
 * moment it is queued so shutdown waits for it like an acknowledged turn. The
 * job handles its own errors; a rejection only frees its slot. The returned
 * promise settles when the job has run.
 */
export function runBackgroundJob(job: () => Promise<unknown>): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const start = () => {
      runningJobs++;
      void job()
        .catch(() => undefined)
        .finally(() => {
          runningJobs--;
          resolve();
          queued.shift()?.();
        });
    };
    if (runningJobs < MAX_CONCURRENT_BACKGROUND_JOBS) start();
    else queued.push(start);
  });
  trackBackgroundTurn(done);
  return done;
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
