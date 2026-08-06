// SPDX-License-Identifier: AGPL-3.0-or-later

import { topModelsWithRest, MAX_NAMED_MODELS } from "./model-distribution-chart";
import type { ModelRow } from "@/lib/api";

const row = (model: string, calls: number): ModelRow =>
  ({ model, calls }) as ModelRow;

const others = (count: number) => `others:${count}`;

describe("topModelsWithRest", () => {
  it("names every model when there are few enough", () => {
    const data = [row("a", 3), row("b", 2), row("c", 1)];

    expect(topModelsWithRest(data, others)).toEqual([
      { name: "a", value: 3 },
      { name: "b", value: 2 },
      { name: "c", value: 1 },
    ]);
  });

  /**
   * The reason this exists: a deployment accumulates models, and a pie with
   * eighteen legend entries overflowed its card onto the page. Three slices,
   * whatever the tail.
   */
  it("keeps the two busiest and folds the rest into one slice", () => {
    const data = [row("a", 50), row("b", 30), row("c", 10), row("d", 5), row("e", 5)];

    expect(topModelsWithRest(data, others)).toEqual([
      { name: "a", value: 50 },
      { name: "b", value: 30 },
      { name: "others:3", value: 20 },
    ]);
  });

  it("never returns more than three slices", () => {
    const data = Array.from({ length: 18 }, (_, i) => row(`m${i}`, 18 - i));

    expect(topModelsWithRest(data, others)).toHaveLength(MAX_NAMED_MODELS + 1);
  });

  /**
   * "Others (1)" is strictly worse than naming that one model — it hides a name
   * to save nothing.
   */
  it("does not fold a single remaining model", () => {
    const data = [row("a", 3), row("b", 2), row("c", 1)];

    expect(topModelsWithRest(data, others).map((s) => s.name)).not.toContain("others:1");
  });

  /**
   * Which models get NAMED depends on the order, so it is established here rather
   * than trusted from the API — a store's `ORDER BY` changing must not silently
   * change what the chart claims is busiest.
   */
  it("sorts by calls, whatever order it is given", () => {
    const data = [row("small", 1), row("big", 100), row("mid", 50), row("tiny", 0)];

    expect(topModelsWithRest(data, others).map((s) => s.name)).toEqual([
      "big",
      "mid",
      "others:2",
    ]);
  });

  it("does not mutate its input", () => {
    const data = [row("small", 1), row("big", 100), row("mid", 50), row("tiny", 0)];
    const before = data.map((r) => r.model);

    topModelsWithRest(data, others);

    expect(data.map((r) => r.model)).toEqual(before);
  });

  // The folded total must account for every call, or the pie lies about its whole.
  it("keeps the total intact", () => {
    const data = Array.from({ length: 9 }, (_, i) => row(`m${i}`, i + 1));
    const total = data.reduce((sum, r) => sum + r.calls, 0);

    const sliced = topModelsWithRest(data, others).reduce((sum, s) => sum + s.value, 0);

    expect(sliced).toBe(total);
  });

  it("handles an empty list", () => {
    expect(topModelsWithRest([], others)).toEqual([]);
  });
});
