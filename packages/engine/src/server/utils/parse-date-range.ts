// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";

/** Widest window the analytics aggregates may be asked for in one request. */
const MAX_RANGE_DAYS = 366;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

export function parseDateRange(from?: unknown, to?: unknown) {
  // Express query parsing can yield arrays (e.g. ?from[]=x) — enforce string at runtime.
  if (from !== undefined && typeof from !== "string") {
    throw new BadRequestException('"from" must be a string');
  }
  if (to !== undefined && typeof to !== "string") {
    throw new BadRequestException('"to" must be a string');
  }

  const now = new Date();
  const toDate = to ? new Date(to) : now;
  const fromDate = from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (to && !to.includes("T")) {
    toDate.setUTCHours(23, 59, 59, 999);
  }

  if (isNaN(toDate.getTime()) || isNaN(fromDate.getTime())) {
    throw new BadRequestException("Invalid date format. Use ISO 8601 (e.g. 2025-01-01)");
  }
  if (fromDate > toDate) {
    throw new BadRequestException('"from" must be before "to"');
  }
  /*
    A maximum span, because the analytics queries behind this are aggregate
    scans with no rollup behind them — two of them unnest the jsonb `steps` of
    every message in the window, which no index can serve. Without a ceiling,
    `?from=1970-01-01` is a valid request that asks the database to read the
    whole history, and the routes are held by `analytics:read`, which every
    system role has.
  */
  if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_MS) {
    throw new BadRequestException(
      `Date range must not exceed ${MAX_RANGE_DAYS} days (requested ${Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000)})`,
    );
  }

  return { from: fromDate, to: toDate };
}
