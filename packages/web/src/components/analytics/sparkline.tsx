// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The day-by-day shape of a KPI over the period, without axes or labels.
 *
 * Plain SVG stretched to its box: a tile is too small for a chart library's
 * axes and tooltips, and five resize observers per row cost more than the
 * line is worth. Fewer than two days draw nothing, since one day has no shape.
 */
export function Sparkline({ values, className }: { values: readonly number[]; className?: string }) {
  if (values.length < 2) return null;
  const width = 100;
  const height = 32;
  const max = Math.max(...values);
  const min = Math.min(...values);
  // A flat series sits in the middle, where it reads as "steady" and not as "zero".
  const y = (v: number) => (max === min ? height / 2 : height - 2 - ((v - min) / (max - min)) * (height - 6));
  const line = values
    .map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * width).toFixed(2)} ${y(v).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden className={className}>
      <path d={`${line} L${width} ${height} L0 ${height} Z`} className="fill-foreground/5" />
      <path d={line} fill="none" className="stroke-foreground/70" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
