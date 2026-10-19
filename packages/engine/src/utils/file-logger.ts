// SPDX-License-Identifier: AGPL-3.0-or-later

import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync, type WriteStream } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { sanitizeForLog, setLogTee } from "./create-logger.js";
import { serializeForLog } from "./serialize-for-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG_DIR = resolve(__dirname, "../../../../logs");
const MAX_LOG_FILES = 14; // keep 14 days
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // purge old files every hour

let currentStream: WriteStream | null = null;
let currentDate = "";
let rotationTimer: ReturnType<typeof setInterval> | null = null;

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function logFilePath(date: string): string {
  return join(LOG_DIR, `engine-${date}.log`);
}

function openStream(date: string): WriteStream {
  ensureLogDir();
  return createWriteStream(logFilePath(date), { flags: "a" });
}

/** The stream for `today` (YYYY-MM-DD), rotating to a new file on the first line of a new day. */
function getStream(today: string): WriteStream {
  if (today !== currentDate || !currentStream) {
    if (currentStream) currentStream.end();
    currentDate = today;
    currentStream = openStream(today);
  }
  return currentStream;
}

function purgeOldLogs(): void {
  if (!existsSync(LOG_DIR)) return;
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("engine-") && f.endsWith(".log"))
    .sort();

  while (files.length > MAX_LOG_FILES) {
    const oldest = files.shift()!;
    try {
      unlinkSync(join(LOG_DIR, oldest));
    } catch {
      // best-effort cleanup — ignore permission / race errors
    }
  }
}

// eslint-disable-next-line no-control-regex -- ANSI SGR sequences are control chars by definition
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Strip ANSI color/style codes so on-disk logs stay plain-text and grep-able. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Write one `console.*` call to the day's file as a single line. The date of the
 * line's own timestamp picks the file, so rotation needs no timer.
 */
function writeLine(prefix: string, args: unknown[]): void {
  const timestamp = new Date().toISOString();
  // serializeForLog, not JSON.stringify: `message`/`stack` are non-enumerable, so
  // stringify would drop the diagnostic text and keep the custom fields — which on
  // a pg / AWS SDK / fetch error is where the connection string, the request config
  // and the authorization header live. This file is kept for fourteen days.
  const msg = args.map((a) => (typeof a === "string" ? a : serializeForLog(a))).join(" ");
  // ANSI first, then control chars: sanitizeForLog would otherwise blank the escape
  // byte and leave the visible "[0;32m" tail in the file. The trailing newline is
  // ours and is appended after sanitizing, so one console call stays one log line.
  getStream(timestamp.slice(0, 10)).write(`[${timestamp}] ${prefix}${sanitizeForLog(stripAnsi(msg))}\n`);
}

/** Install file logging — intercepts console.log/warn/error and tees to daily log files. */
export function installFileLogger(): void {
  ensureLogDir();

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeLine("", args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeLine("[WARN] ", args);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    writeLine("[ERROR] ", args);
  };

  // Module loggers (createLogger) write to stdout/stderr, not console.*: tee them too.
  setLogTee((level, line) => writeLine(level === "warn" ? "[WARN] " : level === "error" ? "[ERROR] " : "", [line]));

  // Rotation happens on the first line of a new day (`getStream`); the timer only purges.
  rotationTimer = setInterval(purgeOldLogs, PURGE_INTERVAL_MS);

  // Initial purge
  purgeOldLogs();

  origLog(`File logger active: ${LOG_DIR}/engine-YYYY-MM-DD.log (keep ${MAX_LOG_FILES} days)`);
}

/** Shutdown file logger cleanly. */
export function shutdownFileLogger(): void {
  setLogTee(null);
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
  if (currentStream) {
    currentStream.end();
    currentStream = null;
  }
}
