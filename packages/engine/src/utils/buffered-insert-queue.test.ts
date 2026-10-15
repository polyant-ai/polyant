// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BufferedInsertQueue,
  initializeBufferedInsertQueues,
  shutdownBufferedInsertQueues,
} from "./buffered-insert-queue.js";

const TABLE = { name: "t" };

/** A db that refuses any batch containing a row equal to `poison`, or everything when `down`. */
function fakeDb(state: { down?: boolean } = {}) {
  const written: number[][] = [];
  return {
    written,
    insert: () => ({
      values: async (rows: number[]) => {
        if (state.down || rows.includes(-1)) throw new Error("refused");
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
