// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The filename rule, at the write — where it belongs, because the key is what
 * gets stored and every later read is stuck with it.
 */

import { describe, it, expect } from "vitest";
import { safeKeySegment } from "./agent-storage.js";

describe("safeKeySegment", () => {
  it("strips the separators that would add segments to the key", () => {
    expect(safeKeySegment("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeKeySegment("a\\b.pdf")).toBe("a_b.pdf");
  });

  /*
    A name that REDUCES to a traversal is the case the old rule missed: it was
    written happily and then refused on every read, so the file existed and could
    never be opened.
  */
  it.each([[".."], ["."], ["  ..  "], [""], ["   "]])(
    "refuses %p, which leaves nothing usable",
    (raw) => {
      expect(safeKeySegment(raw)).toBeNull();
    },
  );

  /*
    Legal in a name and legal in a key. What they need is percent-encoding in the
    URL — the tool and the panel each do that per segment — not mangling here.
  */
  it.each([
    ["report #12.pdf"],
    ["report?.pdf"],
    ["report..pdf"],
    ["my report.pdf"],
    ["fattura-№7.pdf"],
    ["100%-done.pdf"],
  ])("leaves %p alone", (raw) => {
    expect(safeKeySegment(raw)).toBe(raw);
  });
});
