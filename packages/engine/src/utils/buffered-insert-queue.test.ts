// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BufferedInsertQueue,
  initializeBufferedInsertQueues,
  shutdownBufferedInsertQueues,
} from "./buffered-insert-queue.js";

const TABLE = { name: "t" };

/** A db that refuses any batch containing a row equal to `poison`, or everything when `down`. */
function fakeDb(state: { down?: boolean; reset?: boolean } = {}) {
  const written: number[][] = [];
  return {
    written,
    insert: () => ({
      values: async (rows: number[]) => {
        if (state.down) throw new Error("refused");
        if (rows.includes(-1)) throw Object.assign(new Error("null value"), { code: "23502" });
        if (rows.includes(-2) && state.reset !== false) {
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        }
        written.push(rows);
      },
    }),
  };
}

describe("BufferedInsertQueue", () => {
  afterEach(async () => {
    await shutdownBufferedInsertQueues();
    vi.restoreAllMocks();
  });

  it("drops a refused row and writes its neighbours", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDb();
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows" });
    q.initialize(db);
    for (const n of [1, -1, 2]) q.push(n);
    await q.flush();
    expect(db.written.flat()).toEqual([1, 2]);
    await q.flush();
    expect(db.written.flat()).toEqual([1, 2]);
  });

  it("requeues a row that fails with a connection error and writes it on the next flush", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = { reset: true };
    const db = fakeDb(state);
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows", batchAt: 100 });
    q.initialize(db);
    for (const n of [1, -2, 3]) q.push(n);
    await q.flush();
    expect(db.written.flat()).toEqual([1]);
    state.reset = false;
    await q.flush();
    expect(db.written.flat()).toEqual([1, -2, 3]);
  });

  it("recognises a data error wrapped in a cause, and drops and reports the row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onRefused = vi.fn();
    const db = {
      written: [] as number[][],
      insert() {
        return {
          values: async (rows: number[]) => {
            if (rows.includes(-1)) throw new Error("wrapped", { cause: { code: "22P02" } });
            db.written.push(rows);
          },
        };
      },
    };
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows", batchAt: 100, onRefused });
    q.initialize(db);
    for (const n of [1, -1]) q.push(n);
    await q.flush();
    expect(onRefused).toHaveBeenCalledWith([-1], 1);
    await q.flush();
    expect(db.written.flat()).toEqual([1]);
  });

  it("drops and reports a lone row the database refuses instead of requeueing it forever", async () => {
    // A single-row batch never reached the row-by-row fallback, so a refused row
    // went back to the buffer and was refused again on every flush.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onRefused = vi.fn();
    const db = fakeDb();
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows", batchAt: 100, onRefused });
    q.initialize(db);
    q.push(-1);
    await q.flush();
    expect(onRefused).toHaveBeenCalledWith([-1], 0);
    q.push(4);
    await q.flush();
    expect(db.written).toEqual([[4]]);
  });

  it("still requeues a lone row that fails for a reason other than its data", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = { reset: true };
    const db = fakeDb(state);
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows", batchAt: 100 });
    q.initialize(db);
    q.push(-2);
    await q.flush();
    expect(db.written).toEqual([]);
    state.reset = false;
    await q.flush();
    expect(db.written).toEqual([[-2]]);
  });

  it("keeps everything while the database is down and writes it once it is back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = { down: true };
    const db = fakeDb(state);
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows" });
    q.initialize(db);
    for (const n of [1, 2, 3]) q.push(n);
    await q.flush();
    expect(db.written).toEqual([]);
    state.down = false;
    await q.flush();
    expect(db.written).toEqual([[1, 2, 3]]);
  });

  it("keeps the newest rows when the buffer overflows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = { down: true };
    const db = fakeDb(state);
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows", maxBuffer: 3, batchAt: 100 });
    q.initialize(db);
    for (const n of [1, 2, 3, 4, 5]) q.push(n);
    await q.flush();
    state.down = false;
    await q.flush();
    expect(db.written).toEqual([[3, 4, 5]]);
  });

  it("starts and stops every registered queue", async () => {
    const db = fakeDb();
    const q = new BufferedInsertQueue<number>({ table: TABLE, label: "rows", batchAt: 100 });
    initializeBufferedInsertQueues(db);
    q.push(7);
    await shutdownBufferedInsertQueues();
    expect(db.written).toEqual([[7]]);
  });
});
