// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const resetStuckProcessingAll = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("./store.js", () => ({ resetStuckProcessingAll }));

import { startStuckDocumentSweep } from "./stuck-document-sweep.js";

beforeEach(() => {
  vi.useFakeTimers();
  resetStuckProcessingAll.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startStuckDocumentSweep", () => {
  it("recovers at boot, keeps recovering on its interval, and stops when asked", async () => {
    const stop = await startStuckDocumentSweep(60_000);
    expect(resetStuckProcessingAll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(resetStuckProcessingAll).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resetStuckProcessingAll).toHaveBeenCalledTimes(3);
  });

  it("keeps going after a failed run", async () => {
    resetStuckProcessingAll.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const stop = await startStuckDocumentSweep(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resetStuckProcessingAll).toHaveBeenCalledTimes(2);
    stop();
  });
});
