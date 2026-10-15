// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./rrf.js";

type Row = { id: string };
const toItem = (r: Row) => ({ id: r.id, score: 0 });
const keyOf = (r: Row) => r.id;

describe("reciprocalRankFusion", () => {
  it("sums scores for a key found in both lists and ranks it first", () => {
    const out = reciprocalRankFusion(
      [
        { rows: [{ id: "a" }, { id: "b" }], keyOf, toItem },
        { rows: [{ id: "b" }, { id: "c" }], keyOf, toItem },
      ],
      10,
    );
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(out[0].score).toBe(Math.round((1 / 62 + 1 / 61) * 10000) / 10000);
  });

  it("honours the limit", () => {
    const out = reciprocalRankFusion([{ rows: [{ id: "a" }, { id: "b" }], keyOf, toItem }], 1);
    expect(out).toHaveLength(1);
  });
});
