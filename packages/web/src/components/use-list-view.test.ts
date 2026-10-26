// SPDX-License-Identifier: AGPL-3.0-or-later

import { useListView } from "./use-list-view";

interface Row {
  name: string;
  line?: string;
}

const ROWS: Row[] = [
  { name: "zeta", line: "last one" },
  { name: "Alpha", line: "first one" },
  { name: "émile", line: "accented" },
  { name: "beta" },
];
const text = (row: Row) => [row.name, row.line];

describe("useListView", () => {
  it("orders rows by the sort key with locale rules, so an accented name does not land after z", () => {
    const names = useListView(ROWS, "", text, (row) => row.name).map((row) => row.name);
    expect(names).toEqual(["Alpha", "beta", "émile", "zeta"]);
  });

  it("keeps the given order when the list has a meaningful one", () => {
    const names = useListView(ROWS, "", text, null).map((row) => row.name);
    expect(names).toEqual(["zeta", "Alpha", "émile", "beta"]);
  });

  it("keeps the rows whose visible text holds every typed word, in any order", () => {
    const names = useListView(ROWS, "ONE first", text, (row) => row.name).map((row) => row.name);
    expect(names).toEqual(["Alpha"]);
  });

  it("returns nothing when no row matches and does not touch the input array", () => {
    const input = [...ROWS];
    expect(useListView(input, "nothing like this", text, (row) => row.name)).toEqual([]);
    useListView(input, "", text, (row) => row.name);
    expect(input).toEqual(ROWS);
  });
});
