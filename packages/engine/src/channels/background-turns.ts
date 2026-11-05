// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";

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
 * The kinds of work owed after a turn, each with its own queue and limit
 * (`config.backgroundJobs`): the conversation's title and summary (`turn`),
 * and its memory extraction (`memory`). The post-response work of a turn is up
 * to three model calls and a run of database transactions; under load,
 * unbounded, it competed with the turns themselves for the connection pool,
 * and in one shared queue a backlog of extractions held back the summaries
 * that keep the next turns' history short.
 */
export type BackgroundLane = "turn" | "memory";

/** How many jobs of a kind run at once. */
export function backgroundJobLimit(lane: BackgroundLane): number {
  return lane === "turn" ? config.backgroundJobs.turnConcurrency : config.backgroundJobs.memoryConcurrency;
}

const lanes: Record<BackgroundLane, { queued: Array<() => void>; running: number }> = {
  turn: { queued: [], running: 0 },
  memory: { queued: [], running: 0 },
};

/**
 * Run work the engine owes after a turn has been answered: queued behind at
 * most {@link backgroundJobLimit} others of its kind, and tracked from the
 * moment it is queued so shutdown waits for it like an acknowledged turn. The
 * job handles its own errors; a rejection only frees its slot. The returned
 * promise settles when the job has run.
 */
export function runBackgroundJob(lane: BackgroundLane, job: () => Promise<unknown>): Promise<void> {
  const state = lanes[lane];
  const done = new Promise<void>((resolve) => {
    const start = () => {
      state.running++;
      void job()
        .catch(() => undefined)
        .finally(() => {
          state.running--;
          resolve();
          state.queued.shift()?.();
        });
    };
    if (state.running < backgroundJobLimit(lane)) start();
    else state.queued.push(start);
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
