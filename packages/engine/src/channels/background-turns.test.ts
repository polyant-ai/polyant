// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shutdown waits for turns a webhook already acknowledged. Telegram, Slack and
 * Twilio stop retrying once answered 200, so a turn the shutdown cut off after
 * the HTTP server closed was lost without a reply.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BackgroundTurns = typeof import("./background-turns.js");
let trackBackgroundTurn: BackgroundTurns["trackBackgroundTurn"];
let drainBackgroundTurns: BackgroundTurns["drainBackgroundTurns"];
let pendingBackgroundTurns: BackgroundTurns["pendingBackgroundTurns"];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("background turns", () => {
  // The registry is module state, and the grace-period test leaves a turn that
  // never settles in it. A fresh module per test keeps that turn from deciding
  // what the next test sees.
  beforeEach(async () => {
    vi.resetModules();
    ({ trackBackgroundTurn, drainBackgroundTurns, pendingBackgroundTurns } = await import("./background-turns.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for an acknowledged turn to finish", async () => {
    const turn = deferred();
    trackBackgroundTurn(turn.promise);
    let drained = false;
    const drain = drainBackgroundTurns(5_000).then((r) => {
      drained = true;
      return r;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    turn.resolve();

    await expect(drain).resolves.toEqual({ pending: 0 });
    expect(pendingBackgroundTurns()).toBe(0);
  });

  it("waits for a turn acknowledged while it is already waiting", async () => {
    const first = deferred();
    const second = deferred();
    trackBackgroundTurn(first.promise);
    const drain = drainBackgroundTurns(5_000);

    trackBackgroundTurn(second.promise);
    first.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingBackgroundTurns()).toBe(1);
    second.resolve();

    await expect(drain).resolves.toEqual({ pending: 0 });
  });

  it("gives up after the grace period and reports what is still running", async () => {
    vi.useFakeTimers();
    trackBackgroundTurn(new Promise(() => {}));

    const drain = drainBackgroundTurns(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(drain).resolves.toEqual({ pending: 1 });
  });

  it("stops tracking a turn that fails", async () => {
    vi.useRealTimers();
    const before = pendingBackgroundTurns();
    trackBackgroundTurn(Promise.reject(new Error("boom")));
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingBackgroundTurns()).toBe(before);
  });
});
