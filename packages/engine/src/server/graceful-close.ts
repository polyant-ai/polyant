// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";

/**
 * How long requests already in flight when shutdown starts — a chat turn
 * streaming its reply — get to finish before their connections are dropped.
 * Kept well under the stop timeouts of the platforms the engine runs on, so the
 * rest of the shutdown sequence still runs before the process is killed.
 */
export const HTTP_SHUTDOWN_GRACE_MS = 10_000;

/**
 * Close the HTTP server, waiting at most `graceMs` for open connections.
 *
 * `app.close()` ends in Node's `server.close()`, which stops accepting
 * connections and then waits for every open one to finish. A response that
 * never finishes on its own (an SSE stream a client keeps open) made it wait
 * forever, so the steps after it in the shutdown sequence — flushing the audit
 * buffers, stopping channels and schedulers — never ran before the platform's
 * SIGKILL. Nest's `forceCloseConnections` would drop everything at once, cutting
 * in-flight turns too; this gives them the grace period first.
 */
export async function closeHttpServer(
  app: INestApplication,
  graceMs: number = HTTP_SHUTDOWN_GRACE_MS,
): Promise<{ forced: boolean }> {
  const server = app.getHttpServer() as Server;
  let forced = false;
  const deadline = setTimeout(() => {
    forced = true;
    server.closeAllConnections();
  }, graceMs);
  try {
    await app.close();
  } finally {
    clearTimeout(deadline);
  }
  return { forced };
}

/** One named step of the shutdown sequence. */
export interface ShutdownStep {
  name: string;
  run: () => unknown;
}

/**
 * Run the shutdown steps in order, each on its own: a step that throws or
 * rejects is logged and the next one still runs. Returns the names of the steps
 * that failed.
 *
 * Without this a rejection in one step (a trace-store flush against a database
 * already gone, say) skipped every step after it, `process.exit` included, and
 * the process hung until the platform's SIGKILL.
 */
export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  log: Pick<Console, "error"> = console,
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failed.push(step.name);
      log.error(`Shutdown step "${step.name}" failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return failed;
}
