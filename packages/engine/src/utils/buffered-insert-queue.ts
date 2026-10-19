// SPDX-License-Identifier: AGPL-3.0-or-later

import { createLogger } from "./create-logger.js";

const log = createLogger();

// ---------------------------------------------------------------------------
// Buffered batch writer shared by every append-only log table (traces, AI
// logs, tool audit, management audit, ...). Writing a row must never block the
// request path, so rows are buffered and inserted out of band.
// ---------------------------------------------------------------------------

/** Minimal DB interface for insert operations (the shared `db` satisfies it). */
export interface InsertableDb {
  insert(table: unknown): { values(v: unknown): Promise<unknown> };
}

export interface BufferedInsertQueueOptions<T> {
  /** Drizzle table the rows are inserted into. */
  table: unknown;
  /** Plural noun used in log lines, e.g. "audit entries". */
  label: string;
  /** Buffered rows beyond this are dropped, oldest first. Default 500. */
  maxBuffer?: number;
  /** Interval between background flushes. Default 5000 ms. */
  flushMs?: number;
  /** Buffer length that triggers an immediate flush. Default 10. */
  batchAt?: number;
  /** Called when rows were refused while their neighbours went in. Defaults to one warning. */
  onRefused?: (rows: T[], written: number) => void;
}

/** SQLSTATE of a Postgres error, read from the error or the cause drizzle/porsager wrap it in. */
function sqlState(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True when the database refused this row itself: SQLSTATE class 22 (data exception) or 23
 * (integrity constraint violation). Anything else (connection reset, timeout, shutdown,
 * resource limits, unknown) says nothing about the row and must not cost the row its place.
 */
export function isDataError(err: unknown): boolean {
  const state = sqlState(err);
  return state !== undefined && (state.startsWith("22") || state.startsWith("23"));
}

const queues = new Set<BufferedInsertQueue<never>>();

/** Start the background flush of every queue created so far. */
export function initializeBufferedInsertQueues(db: InsertableDb): void {
  for (const queue of queues) queue.initialize(db);
}

/** Stop every queue's timer and write what is left. Never rejects. */
export async function shutdownBufferedInsertQueues(): Promise<void> {
  await Promise.all([...queues].map((queue) => queue.shutdown()));
}

/**
 * Rows are written as one multi-row INSERT. If that fails, they are inserted one by one to tell
 * "one bad row" from "the database is down", because the two need opposite handling: a refused
 * row that is re-queued fails every later batch, so nothing behind it would ever be written,
 * while a database that is down must lose nothing. A row is dropped only when the database
 * refuses its data (SQLSTATE class 22 or 23). Any other error stops the fallback and puts that
 * row and every row not yet tried back in the buffer, capped to `maxBuffer` with the newest kept.
 */
export class BufferedInsertQueue<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private db: InsertableDb | null = null;
  private inFlight: Promise<void> | null = null;
  private flushSkipped = 0;
  private readonly maxBuffer: number;
  private readonly flushMs: number;
  private readonly batchAt: number;

  constructor(private readonly options: BufferedInsertQueueOptions<T>) {
    this.maxBuffer = options.maxBuffer ?? 500;
    this.flushMs = options.flushMs ?? 5000;
    this.batchAt = options.batchAt ?? 10;
    queues.add(this as unknown as BufferedInsertQueue<never>);
  }

  initialize(db: InsertableDb): void {
    this.db = db;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.flush(), this.flushMs);
  }

  push(row: T): void {
    this.buffer.push(row);
    if (this.buffer.length >= this.batchAt) void this.flush();
  }

  /** The newest buffered row matching `predicate`, for patching it before it is written. */
  findLast(predicate: (row: T) => boolean): T | undefined {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (predicate(this.buffer[i]!)) return this.buffer[i];
    }
    return undefined;
  }

  /** Write the buffer. While another flush is running, returns that one instead of starting a second. */
  flush(): Promise<void> {
    if (this.inFlight) {
      if (this.buffer.length > 0) {
        // One skip in twenty is enough to spot capacity pressure.
        this.flushSkipped += 1;
        if (this.flushSkipped % 20 === 0) {
          log.debug(
            "buffered-insert",
            `${this.options.label}: flush skipped ${this.flushSkipped}x (buffer=${this.buffer.length}, another flush in progress)`,
          );
        }
      }
      return this.inFlight;
    }
    if (this.buffer.length === 0 || !this.db) return Promise.resolve();
    this.inFlight = this.write(this.db).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    // Rows pushed while the first flush ran.
    await this.flush();
  }

  private async write(db: InsertableDb): Promise<void> {
    const rows = this.buffer;
    this.buffer = [];
    const { table, label } = this.options;

    try {
      await db.insert(table).values(rows);
      return;
    } catch (err) {
      log.error("buffered-insert", `Failed to flush ${label}`, err);
    }

    const refused: T[] = [];
    let written = 0;
    let index = 0;
    if (rows.length > 1) {
      for (; index < rows.length; index++) {
        try {
          await db.insert(table).values([rows[index]!]);
          written++;
        } catch (err) {
          if (!isDataError(err)) break;
          refused.push(rows[index]!);
        }
      }
    }

    if (refused.length > 0 && written > 0) this.reportRefused(refused, written);

    // The row that stopped the fallback, and every row not yet tried, go back to the buffer: the
    // cause is the database, not the row. When the fallback did not run (a single row) or the
    // first row failed, that is the whole batch. Oldest first, then rows pushed since the flush began.
    const requeue = rows.length > 1 ? rows.slice(index) : rows;
    if (requeue.length === 0) return;
    this.buffer = [...requeue, ...this.buffer];
    if (this.buffer.length > this.maxBuffer) {
      const dropped = this.buffer.length - this.maxBuffer;
      this.buffer = this.buffer.slice(-this.maxBuffer);
      log.warn("buffered-insert", `${label}: dropped ${dropped} oldest entries, keeping newest (buffer full)`);
    }
  }

  private reportRefused(rows: T[], written: number): void {
    if (this.options.onRefused) {
      this.options.onRefused(rows, written);
      return;
    }
    log.warn(
      "buffered-insert",
      `${this.options.label}: dropped ${rows.length} un-insertable entries; ${written} entries in the same batch were written.`,
    );
  }
}
