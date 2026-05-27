// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { parseDateRange } from "./parse-date-range.js";

describe("parseDateRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to 30 days ago → now when no params", () => {
    const { from, to } = parseDateRange();
    const now = new Date("2026-02-15T12:00:00.000Z");
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    expect(to.getTime()).toBe(now.getTime());
    expect(from.getTime()).toBe(thirtyDaysAgo.getTime());
  });

  it("parses explicit from and to ISO strings", () => {
    const { from, to } = parseDateRange(
      "2026-01-01T00:00:00.000Z",
      "2026-01-31T23:59:59.999Z",
    );
    expect(from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-01-31T23:59:59.999Z");
  });

  it('date-only "to" gets end-of-day (23:59:59.999)', () => {
    const { to } = parseDateRange(undefined, "2026-02-22");
    expect(to.getUTCHours()).toBe(23);
    expect(to.getUTCMinutes()).toBe(59);
    expect(to.getUTCSeconds()).toBe(59);
    expect(to.getUTCMilliseconds()).toBe(999);
  });

  it('"to" with time component is NOT adjusted to end-of-day', () => {
    const { to } = parseDateRange(undefined, "2026-02-22T10:30:00.000Z");
    expect(to.getUTCHours()).toBe(10);
    expect(to.getUTCMinutes()).toBe(30);
  });

  it("throws BadRequestException for invalid from date", () => {
    expect(() => parseDateRange("not-a-date")).toThrow(BadRequestException);
  });

  it("throws BadRequestException for invalid to date", () => {
    expect(() => parseDateRange(undefined, "garbage")).toThrow(BadRequestException);
  });

  it('throws BadRequestException when from > to', () => {
    expect(() =>
      parseDateRange("2026-03-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ).toThrow(BadRequestException);
    expect(() =>
      parseDateRange("2026-03-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ).toThrow('"from" must be before "to"');
  });

  it("works when only from is provided", () => {
    const { from, to } = parseDateRange("2026-01-01T00:00:00Z");
    expect(from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // to defaults to now
    expect(to.getTime()).toBe(new Date("2026-02-15T12:00:00.000Z").getTime());
  });

  it("throws BadRequestException when from is an array (HTTP param tampering)", () => {
    expect(() => parseDateRange(["2026-01-01"] as unknown as string)).toThrow(
      BadRequestException,
    );
  });

  it("throws BadRequestException when to is an array (HTTP param tampering)", () => {
    expect(() =>
      parseDateRange(undefined, ["2026-02-22"] as unknown as string),
    ).toThrow(BadRequestException);
  });
});
