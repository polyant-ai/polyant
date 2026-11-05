// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeNextRun, scheduleConfigSchema } from "./schedule-utils.js";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

describe("computeNextRun for an interval", () => {
  beforeEach(() => {
    // Only the clock: the timing assertion below reads the real performance counter.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the first occurrence when it is still ahead", () => {
    const next = computeNextRun({ type: "interval", everyMs: 3_600_000, anchorAt: "2026-06-15T11:30:00.000Z" });
    expect(next?.toISOString()).toBe("2026-06-15T12:30:00.000Z");
  });

  it("skips to the first occurrence after now when the anchor is far behind", () => {
    // Anchor at midnight, every 7 minutes: 102 steps land at 11:54, the 103rd at 12:01.
    const next = computeNextRun({ type: "interval", everyMs: 7 * 60_000, anchorAt: "2026-06-15T00:00:00.000Z" });
    expect(next?.toISOString()).toBe("2026-06-15T12:01:00.000Z");
  });

  it("never returns now itself: an occurrence that falls on now is already due", () => {
    const next = computeNextRun({ type: "interval", everyMs: 60_000, anchorAt: "2026-06-15T11:58:00.000Z" });
    expect(next?.toISOString()).toBe("2026-06-15T12:01:00.000Z");
  });

  it("answers at once for a one-minute interval anchored decades ago", () => {
    const started = performance.now();
    const next = computeNextRun({ type: "interval", everyMs: 60_000, anchorAt: "2000-01-01T00:00:00.000Z" });
    expect(next?.toISOString()).toBe("2026-06-15T12:01:00.000Z");
    expect(performance.now() - started).toBeLessThan(50);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a stored interval of %s instead of looping forever",
    (everyMs) => {
      expect(() => computeNextRun({ type: "interval", everyMs, anchorAt: "2026-06-15T11:00:00.000Z" })).toThrow(RangeError);
    },
  );

  it("refuses an anchor that is not a date", () => {
    expect(() => computeNextRun({ type: "interval", everyMs: 60_000, anchorAt: "yesterday" })).toThrow(RangeError);
  });
});

describe("scheduleConfigSchema", () => {
  it.each([0, -5, 1, 59_999, 1.5, Number.NaN])("refuses an interval of %s ms", (everyMs) => {
    expect(scheduleConfigSchema.safeParse({ type: "interval", everyMs }).success).toBe(false);
  });

  it("accepts a one-minute interval and keeps only the fields of its type", () => {
    expect(scheduleConfigSchema.parse({ type: "interval", everyMs: 60_000, extra: "x" })).toEqual({
      type: "interval",
      everyMs: 60_000,
    });
  });

  it("refuses an interval anchor that is not a date", () => {
    expect(scheduleConfigSchema.safeParse({ type: "interval", everyMs: 60_000, anchorAt: "soon" }).success).toBe(false);
  });

  it("refuses an unknown type and a type without its fields", () => {
    expect(scheduleConfigSchema.safeParse({ type: "weekly" }).success).toBe(false);
    expect(scheduleConfigSchema.safeParse({ type: "cron" }).success).toBe(false);
    expect(scheduleConfigSchema.safeParse({ type: "one-shot" }).success).toBe(false);
  });
});
