// SPDX-License-Identifier: AGPL-3.0-or-later

export interface RankedBar {
  key: string;
  label: string;
  value: number;
  /** A row that is not a choice of its own (other models, service calls): drawn in grey. */
  muted?: boolean;
}

/**
 * A breakdown as a list of bars, in the order given: name, share, count.
 *
 * It replaces the dashboard's donuts. A donut kept its legend inside a box of
 * fixed height, so long model names wrapped the legend over the ring and cut it
 * off, and the eye cannot compare the slices of a ring anyway. Here every name
 * is written in full on its own line and the bars share one scale.
 */
export function RankedBars({
  rows,
  formatValue = String,
}: {
  rows: readonly RankedBar[];
  formatValue?: (value: number) => string;
}) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => {
        const share = total > 0 ? row.value / total : 0;
        return (
          <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="truncate" title={row.label}>
              {row.label}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.round(share * 100)}% · {formatValue(row.value)}
            </span>
            <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full ${row.muted ? "bg-muted-foreground/50" : "bg-foreground"}`}
                style={{ width: `${share * 100}%` }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
