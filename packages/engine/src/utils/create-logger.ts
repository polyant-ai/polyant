// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared logger factory for colored, timestamped console output.
 * Used by pipeline-logger and the module loggers.
 */

import { errMsg } from "./error.js";

export const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
} as const;

/**
 * One formatter for every log line. `toLocaleTimeString` with options builds a
 * new Intl formatter on each call, about 20x the cost of reusing one, and every
 * log line of every turn pays it. Same output: HH:MM:SS, 24-hour.
 */
const LOG_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Formatted timestamp for log lines (HH:MM:SS, 24-hour). */
export function ts(): string {
  return LOG_TIME.format(new Date());
}

/**
 * Collapse newlines and other control characters into spaces so untrusted text
 * (channel slugs, filenames, message bodies, transcriptions) cannot forge extra
 * log lines — a value containing "\n[INFO] fake entry" would otherwise land in
 * the log as its own record (CWE-117).
 *
 * Apply it to the untrusted VALUE, not to an already-assembled line that carries
 * ANSI colour codes: strip those first (see file-logger's stripAnsi), otherwise
 * the escape byte is replaced and the visible "[0;32m" tail stays behind.
 */
export function sanitizeForLog(text: string): string {
  // NOTE: CodeQL's js/log-injection query does NOT recognise this as a sanitizer,
  // so every call site stays reported and those alerts are dismissed as "won't fix"
  // rather than fixed. PR #256 measured five shapes against the analysis SARIF:
  // three helper variants (lone character class / literal per-terminator replaces /
  // this narrowed `string` signature mirroring `truncate()`), AND — on a two-site
  // pilot — a helper plus a trailing literal replace, AND a bare inline
  // `x.replace(/\n/g," ").replace(/\r/g," ")` with no helper at all. All five stayed
  // reported; only the call sites INSIDE the chokepoints ever cleared.
  //
  // So do NOT reshape this, and do not "just inline the replace" either — that was
  // tried and measured. The protection here is real regardless; see the test.
  return text
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
    // eslint-disable-next-line no-control-regex -- matching control chars is the point
    .replace(/[\x00-\x1f\x7f]/g, " ");
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Resolve the configured verbosity from LOG_LEVEL, falling back to "info" for
 * an unset or invalid value.
 *
 * CONVENTION-EXCEPTION: reads process.env directly instead of going through the
 * Zod `config`. The logger is foundational infrastructure imported by nearly
 * every module — including config.ts's own error path — so depending on the
 * full config graph (which pulls in dotenv/fs) would invert the layering and
 * make the logger fragile to partial `config`/`fs` mocks in tests. The value is
 * validated against the closed set below.
 */
function resolveThreshold(): number {
  const envLevel = process.env.LOG_LEVEL;
  if (envLevel && envLevel in LEVEL_ORDER) {
    return LEVEL_ORDER[envLevel as LogLevel | "silent"];
  }
  return LEVEL_ORDER.info;
}

const threshold = resolveThreshold();

/** Whether a message at `level` should be emitted given the configured LOG_LEVEL. */
export function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= threshold;
}

export interface Logger {
  debug(prefix: string, msg: string): void;
  info(prefix: string, msg: string): void;
  warn(prefix: string, msg: string, err?: unknown): void;
  error(prefix: string, msg: string, err?: unknown): void;
}

type LogTee = (level: "info" | "warn" | "error", line: string) => void;
let tee: LogTee | null = null;

/**
 * Register a second destination for every formatted line (the daily log file,
 * see `installFileLogger`). Lines are written to stdout/stderr directly, so
 * the file logger's `console.*` interception never sees them.
 */
export function setLogTee(fn: LogTee | null): void {
  tee = fn;
}

/**
 * Create a structured logger with colored, timestamped output.
 * The `defaultColor` is used for info-level messages.
 *
 * `warn` and `error` accept an optional error value. At normal levels only its
 * sanitized message is appended to the line. When LOG_LEVEL=debug and the value
 * is an `Error` with a stack, the stack is also written (each line sanitized
 * like the message) through the same stdout/stderr and log-tee path. Other
 * values are logged as their string form and never gain a stack.
 */
export function createLogger(defaultColor: string = COLORS.cyan): Logger {
  function fmt(level: "info" | "warn" | "error", prefix: string, msg: string): string {
    const color = level === "error" ? COLORS.red : level === "warn" ? COLORS.yellow : defaultColor;
    // Sanitize the caller-supplied parts only; the colour codes in the template
    // around them are ours and must survive.
    return `${COLORS.dim}${ts()}${COLORS.reset} ${color}[${sanitizeForLog(prefix)}]${COLORS.reset} ${sanitizeForLog(msg)}`;
  }

  function emit(level: "info" | "warn" | "error", prefix: string, msg: string): void {
    const line = fmt(level, prefix, msg);
    (level === "info" ? process.stdout : process.stderr).write(line + "\n");
    tee?.(level, line);
  }

  function emitWithError(level: "warn" | "error", prefix: string, msg: string, err: unknown): void {
    const detail = err == null ? "" : sanitizeForLog(errMsg(err));
    emit(level, prefix, detail ? `${msg} — ${detail}` : msg);
    if (err instanceof Error && err.stack && shouldLog("debug")) {
      // The first stack line repeats the message already printed above.
      for (const frame of err.stack.split("\n").slice(1)) {
        if (frame.trim()) emit(level, prefix, frame);
      }
    }
  }

  return {
    debug(prefix: string, msg: string): void {
      if (!shouldLog("debug")) return;
      emit("info", prefix, msg);
    },
    info(prefix: string, msg: string): void {
      if (!shouldLog("info")) return;
      emit("info", prefix, msg);
    },
    warn(prefix: string, msg: string, err?: unknown): void {
      if (!shouldLog("warn")) return;
      emitWithError("warn", prefix, msg, err);
    },
    error(prefix: string, msg: string, err?: unknown): void {
      if (!shouldLog("error")) return;
      emitWithError("error", prefix, msg, err);
    },
  };
}
