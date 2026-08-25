// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared logger factory for colored, timestamped console output.
 * Used by pipeline-logger, room-logger, webhook-logger, etc.
 */

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

/** Formatted timestamp for log lines (HH:MM:SS, 24-hour). */
export function ts(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
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
  info(prefix: string, msg: string): void;
  warn(prefix: string, msg: string): void;
  error(prefix: string, msg: string, err?: unknown): void;
}

/**
 * Create a structured logger with colored, timestamped output.
 * The `defaultColor` is used for info-level messages.
 */
export function createLogger(defaultColor: string = COLORS.cyan): Logger {
  function fmt(level: "info" | "warn" | "error", prefix: string, msg: string): string {
    const color = level === "error" ? COLORS.red : level === "warn" ? COLORS.yellow : defaultColor;
    return `${COLORS.dim}${ts()}${COLORS.reset} ${color}[${prefix}]${COLORS.reset} ${msg}`;
  }

  return {
    info(prefix: string, msg: string): void {
      if (!shouldLog("info")) return;
      process.stdout.write(fmt("info", prefix, msg) + "\n");
    },
    warn(prefix: string, msg: string): void {
      if (!shouldLog("warn")) return;
      process.stderr.write(fmt("warn", prefix, msg) + "\n");
    },
    error(prefix: string, msg: string, err?: unknown): void {
      if (!shouldLog("error")) return;
      const errMsg = err instanceof Error ? err.message : String(err ?? "");
      const full = errMsg ? `${msg} — ${errMsg}` : msg;
      process.stderr.write(fmt("error", prefix, full) + "\n");
    },
  };
}
