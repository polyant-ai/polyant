// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Response } from "express";

/**
 * Keep-alive cadence for an SSE turn. Long, output-less tool calls emit no
 * stream parts, so without a periodic byte an idle timeout on the
 * browser/proxy would sever the connection and the client would miss the end
 * of the turn. An SSE comment line (starting with ":") keeps it warm and is
 * ignored by every SSE parser. Below the typical 30–60 s proxy idle cut-off,
 * like the activity-stream heartbeat.
 */
const HEARTBEAT_MS = 25_000;

/**
 * Stream parts that mean the turn has produced something: from the first of
 * them a client disconnect no longer aborts the pipeline. `tool-input-start`
 * comes as soon as the model begins writing a tool call, before the tool runs.
 */
const OUTPUT_PARTS = new Set([
  "text-delta", "reasoning-delta", "tool-input-start", "tool-call", "tool-result",
]);

/**
 * The client side of a streamed turn, shared by every SSE route that relays
 * one (`/v1/chat/completions` with `stream`, and chat/stream), so a client
 * that hangs up gets the same treatment on each.
 *
 * A disconnect aborts the pipeline itself only while the turn has produced
 * nothing: an aborted turn is not persisted, and once the model has written
 * text, reasoned or begun a tool call (which may write), the turn runs to its
 * end and is saved, so its record never goes missing. After that the
 * disconnect only stops the relay.
 *
 * Construct it before the handler's first await. The RESPONSE's `close` is the
 * disconnect signal; the request's is not, since Node 16 fires it as soon as
 * the body parser has read the body, with the client still connected.
 * `writableFinished` tells our own `res.end()` apart from a client that went
 * away.
 */
export class TurnStreamRelay {
  private readonly abortController = new AbortController();
  private produced = false;
  private gone = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly res: Response) {
    res.on("close", () => {
      if (res.writableFinished) return;
      this.stopHeartbeat();
      this.gone = true;
      if (!this.produced && !this.abortController.signal.aborted) this.abortController.abort();
    });
  }

  /** Pass to the pipeline: it aborts the turn on a disconnect before any output. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** The client has gone: stop relaying, the turn itself carries on if it produced anything. */
  get clientGone(): boolean {
    return this.gone;
  }

  /** Record a relayed stream part. */
  observe(partType: string): void {
    if (OUTPUT_PARTS.has(partType)) this.produced = true;
  }

  /** Keep the connection warm during output-less stretches (see HEARTBEAT_MS). */
  startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      try {
        this.res.write(": ping\n\n");
      } catch {
        // Socket already gone; the close handler clears the timer.
      }
    }, HEARTBEAT_MS);
  }

  stopHeartbeat(): void {
    clearInterval(this.heartbeat);
  }
}
