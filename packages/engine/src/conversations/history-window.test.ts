// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The next history starts strictly after the last folded message, so a fold
 * that ended between two messages stamped with the same instant would drop the
 * second one from both the summary and the history.
 */

import { describe, expect, it } from "vitest";
import { messagesToFold } from "./history-window.js";

const at = (ms: number) => ({ createdAt: new Date(Date.UTC(2026, 10, 1) + ms) });
const window = (count: number) => Array.from({ length: count }, (_, i) => at(i * 1_000));

describe("messagesToFold", () => {
  it("folds nothing while the turn keeps the history within its window", () => {
    expect(messagesToFold(window(18), 2)).toBe(0);
  });

  it("folds all but the ten most recent messages once the window is exceeded", () => {
    // 20 read + 2 added = 22: keep the last 10 (8 read + 2 added), fold 12.
    expect(messagesToFold(window(20), 2)).toBe(12);
  });

  it("does not end the fold between two messages stamped with the same instant", () => {
    const rows = window(20);
    rows[12] = { createdAt: rows[11].createdAt };

    expect(messagesToFold(rows, 2)).toBe(11);
  });
});
