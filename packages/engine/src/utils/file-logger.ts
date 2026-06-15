// SPDX-License-Identifier: AGPL-3.0-or-later

import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync, type WriteStream } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG_DIR = resolve(__dirname, "../../../../logs");
const MAX_LOG_FILES = 14; // keep 14 days
const ROTATION_CHECK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

let currentStream: WriteStream | null = null;
let currentDate = "";
let rotationTimer: ReturnType<typeof setInterval> | null = null;

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function todayString(): string {
  return new Date().toISOString().split("T")[0];
}

function logFilePath(date: string): string {
  return join(LOG_DIR, `engine-${date}.log`);
}

function openStream(date: string): WriteStream {
  ensureLogDir();
  return createWriteStream(logFilePath(date), { flags: "a" });
}

function getStream(): WriteStream {
  const today = todayString();
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

function formatLine(args: unknown[]): string {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  return `[${ts}] ${stripAnsi(msg)}\n`;
}

/** Install file logging — intercepts console.log/warn/error and tees to daily log files. */
export function installFileLogger(): void {
  ensureLogDir();

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    getStream().write(formatLine(args));
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    getStream().write("[WARN] " + formatLine(args));
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    getStream().write("[ERROR] " + formatLine(args));
  };

  // Periodic rotation check + purge
  rotationTimer = setInterval(() => {
    const today = todayString();
    if (today !== currentDate) {
      getStream(); // triggers rotation
    }
    purgeOldLogs();
  }, ROTATION_CHECK_INTERVAL_MS);

  // Initial purge
  purgeOldLogs();

  origLog(`File logger active: ${LOG_DIR}/engine-YYYY-MM-DD.log (keep ${MAX_LOG_FILES} days)`);
}

/** Shutdown file logger cleanly. */
export function shutdownFileLogger(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
  if (currentStream) {
    currentStream.end();
    currentStream = null;
  }
}
