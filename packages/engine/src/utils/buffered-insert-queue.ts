// SPDX-License-Identifier: AGPL-3.0-or-later

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
 * while a database that is down must lose nothing. Rows are dropped only when their neighbours
 * went in; if every row fails the whole batch goes back to the buffer, capped to `maxBuffer`
 * with the newest rows kept.
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
          console.debug(
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
      console.error(`Failed to flush ${label}:`, err);
    }

    const refused: T[] = [];
    let written = 0;
    if (rows.length > 1) {
      for (const row of rows) {
        try {
          await db.insert(table).values([row]);
          written++;
        } catch {
          refused.push(row);
        }
      }
    }

    if (written > 0) {
      if (refused.length > 0) this.reportRefused(refused, written);
      return;
    }

    // Nothing went in: the cause is the database, so keep every row for the next tick.
    // Prepend them so ordering is preserved: oldest first, then rows pushed since the flush began.
    this.buffer = [...rows, ...this.buffer];
    if (this.buffer.length > this.maxBuffer) {
      const dropped = this.buffer.length - this.maxBuffer;
      this.buffer = this.buffer.slice(-this.maxBuffer);
      console.warn(`${label}: dropped ${dropped} oldest entries, keeping newest (buffer full)`);
    }
  }

  private reportRefused(rows: T[], written: number): void {
    if (this.options.onRefused) {
      this.options.onRefused(rows, written);
      return;
    }
    console.warn(
      `${this.options.label}: dropped ${rows.length} un-insertable entries; ${written} entries in the same batch were written.`,
    );
  }
}
