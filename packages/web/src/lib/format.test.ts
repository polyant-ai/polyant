// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRelativeTime, lastDays, toIsoDay, truncate } from "./format";

// Simple translation mock
const t = (key: string, params?: Record<string, string | number>) => {
  if (params) {
    let result = key;
    for (const [k, v] of Object.entries(params)) {
      result += `:${k}=${v}`;
    }
    return result;
  }
  return key;
};

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns em dash for null date", () => {
    expect(formatRelativeTime(null, t as never, "en")).toBe("\u2014");
  });

  it("returns 'just now' for dates less than a minute ago", () => {
    const date = new Date("2024-06-15T11:59:30Z").toISOString();
    expect(formatRelativeTime(date, t as never, "en")).toBe("instances.time.justNow");
  });

  it("returns minutes ago for dates within the last hour", () => {
    const date = new Date("2024-06-15T11:45:00Z").toISOString();
    expect(formatRelativeTime(date, t as never, "en")).toContain("instances.time.minutesAgo");
    expect(formatRelativeTime(date, t as never, "en")).toContain("count=15");
  });

  it("returns hours ago for dates within the last day", () => {
    const date = new Date("2024-06-15T06:00:00Z").toISOString();
    expect(formatRelativeTime(date, t as never, "en")).toContain("instances.time.hoursAgo");
    expect(formatRelativeTime(date, t as never, "en")).toContain("count=6");
  });

  it("returns days ago for dates within the last month", () => {
    const date = new Date("2024-06-10T12:00:00Z").toISOString();
    expect(formatRelativeTime(date, t as never, "en")).toContain("instances.time.daysAgo");
    expect(formatRelativeTime(date, t as never, "en")).toContain("count=5");
  });

  it("returns locale date string for dates older than 30 days", () => {
    const date = new Date("2024-01-01T12:00:00Z").toISOString();
    const result = formatRelativeTime(date, t as never, "en");
    // Should be a date string, not a translation key
    expect(result).not.toContain("instances.time");
  });
});

describe("truncate", () => {
  it("returns original text if shorter than maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns original text if exactly maxLen", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and adds ellipsis if longer than maxLen", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });

  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });
});

describe("toIsoDay and lastDays", () => {
  it("formats a calendar day as YYYY-MM-DD", () => {
    expect(toIsoDay(new Date(2026, 6, 4))).toBe("2026-07-04");
  });

  it("spans from N days back to today, both inclusive", () => {
    expect(lastDays(30, new Date(2026, 6, 31))).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });
});
