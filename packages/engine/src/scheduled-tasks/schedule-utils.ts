// SPDX-License-Identifier: AGPL-3.0-or-later

import { Cron } from "croner";
import { z } from "zod";
import type { ScheduleConfig } from "./schema.js";

/**
 * The shortest interval a schedule may declare. The scheduler ticks every 30 s, so a
 * shorter interval asks for more than it can deliver; zero or negative never advances.
 */
export const MIN_INTERVAL_MS = 60_000;

const isDate = (value: string) => !Number.isNaN(Date.parse(value));

const cronSchedule = z.object({
  type: z.literal("cron"),
  expression: z.string().min(1),
  timezone: z.string().min(1).optional(),
});

const oneShotSchedule = z.object({
  type: z.literal("one-shot"),
  // An ISO timestamp, or a relative "+20m" the writer resolves before saving.
  runAt: z.string().min(1),
});

const intervalSchedule = (everyMs: z.ZodNumber) =>
  z.object({
    type: z.literal("interval"),
    everyMs,
    anchorAt: z.string().refine(isDate, "must be a date").optional(),
  });

/**
 * The one rule for a new schedule, applied wherever one is written: the HTTP API
 * and the `scheduleTask` tool. Unknown fields are dropped.
 */
export const scheduleConfigSchema = z.discriminatedUnion("type", [
  cronSchedule,
  intervalSchedule(z.number().int().min(MIN_INTERVAL_MS)),
  oneShotSchedule,
]);

/**
 * A schedule already stored, as an export carries it back in. Earlier releases
 * accepted any interval, so it refuses only what the scheduler cannot step with
 * (see `computeNextRun`): an export of what an agent runs imports again.
 */
export const storedScheduleSchema = z.discriminatedUnion("type", [
  cronSchedule,
  intervalSchedule(z.number().positive()),
  oneShotSchedule,
]);

/** Validate a schedule from outside; the error names the first field at fault. */
export function parseSchedule(raw: unknown): { schedule: ScheduleConfig } | { error: string } {
  const parsed = scheduleConfigSchema.safeParse(raw);
  if (parsed.success) return { schedule: parsed.data };
  const issue = parsed.error.issues[0];
  const field = ["schedule", ...issue.path].join(".");
  if (issue.path[0] === "everyMs") return { error: `Field '${field}' must be an integer of at least ${MIN_INTERVAL_MS} ms.` };
  return { error: `Field '${field}' is invalid: ${issue.message}.` };
}

/**
 * Compute the next run time for a schedule configuration.
 * Returns null if the schedule has no future runs (e.g. expired one-shot).
 */
export function computeNextRun(schedule: ScheduleConfig, lastRunAt?: Date): Date | null {
  const now = new Date();

  switch (schedule.type) {
    case "cron": {
      const job = new Cron(schedule.expression, {
        timezone: schedule.timezone,
      });
      const next = job.nextRun();
      return next;
    }

    case "interval": {
      // A stored row is not re-validated against the writers' minimum, but a value the
      // arithmetic cannot step with fails the task instead of the caller.
      const { everyMs } = schedule;
      if (!Number.isFinite(everyMs) || everyMs <= 0) {
        throw new RangeError(`Interval schedule has an invalid everyMs: ${String(everyMs)}`);
      }
      const anchor = schedule.anchorAt ? new Date(schedule.anchorAt) : (lastRunAt ?? now);
      if (Number.isNaN(anchor.getTime())) {
        throw new RangeError(`Interval schedule has an invalid anchorAt: ${String(schedule.anchorAt)}`);
      }
      // The first occurrence after now, in one step however far behind the anchor is.
      const first = anchor.getTime() + everyMs;
      if (first > now.getTime()) return new Date(first);
      return new Date(first + (Math.floor((now.getTime() - first) / everyMs) + 1) * everyMs);
    }

    case "one-shot": {
      const runAt = new Date(schedule.runAt);
      return runAt.getTime() > now.getTime() ? runAt : null;
    }
  }
}

/**
 * Parse a relative duration string ("+20m", "+1h", "+2d") into an absolute Date.
 * Supports: s (seconds), m (minutes), h (hours), d (days).
 */
export function parseRelativeDuration(str: string): Date {
  const match = str.match(/^\+(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid relative duration: "${str}". Expected format: +<number><s|m|h|d>`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return new Date(Date.now() + value * multipliers[unit]);
}

/**
 * Format a schedule config into a human-readable string for display.
 */
export function formatScheduleHuman(schedule: ScheduleConfig): string {
  switch (schedule.type) {
    case "cron": {
      return schedule.expression;
    }
    case "interval": {
      const ms = schedule.everyMs;
      if (ms >= 86_400_000) return `Every ${Math.round(ms / 86_400_000)}d`;
      if (ms >= 3_600_000) return `Every ${Math.round(ms / 3_600_000)}h`;
      if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
      return `Every ${Math.round(ms / 1_000)}s`;
    }
    case "one-shot": {
      return `Once at ${new Date(schedule.runAt).toISOString()}`;
    }
  }
}

/** Backoff schedule for retries (30s, 1m, 5m) */
export const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 300_000];

/** Max consecutive errors before auto-disable */
export const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Compute the next retry time based on consecutive error count.
 */
export function computeRetryDelay(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx];
}
