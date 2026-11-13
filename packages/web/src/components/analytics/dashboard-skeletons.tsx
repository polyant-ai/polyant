// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ComponentType, CSSProperties } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * What a dashboard card shows before its data arrives: the card's real title,
 * and inside it the outline of what will be drawn there (a curve, ranked bars,
 * table rows, the hour grid), at the height the real content takes. The page
 * keeps its layout from the first frame, and each card fills in as its own
 * answer lands, without anything below it moving.
 */

export function Bone({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={cn("skeleton-shimmer block rounded-md", className)} style={style} />;
}

/** A KPI tile with its label and icon, the figure and its comparison still to come. */
export function KpiTileSkeleton({ label, icon: Icon }: { label: string; icon?: ComponentType<{ className?: string }> }) {
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-busy="true">
      <div className="flex flex-col gap-1.5 px-5 pt-5 pb-4">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
          {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        </div>
        <div className="flex h-8 items-center">
          <Bone className="h-6 w-24" />
        </div>
        <div className="flex min-h-5 items-center">
          <Bone className="h-4 w-28 rounded-full" />
        </div>
      </div>
      <Bone className="mt-auto h-10 w-full rounded-none opacity-60" />
    </Card>
  );
}

// A gentle rise and fall, as a daily series usually draws.
const CURVE = "polygon(0% 72%, 12% 60%, 24% 66%, 36% 44%, 48% 52%, 60% 30%, 72% 42%, 84% 26%, 100% 34%, 100% 100%, 0% 100%)";

function LineShape({ height }: { height: number }) {
  return (
    <div className="flex flex-col gap-2" style={{ height }}>
      <Bone className="min-h-0 flex-1 rounded-none" style={{ clipPath: CURVE }} />
      <div className="flex justify-between">
        {Array.from({ length: 5 }, (_, i) => (
          <Bone key={i} className="h-2.5 w-10" />
        ))}
      </div>
    </div>
  );
}

const BAR_WIDTHS = [82, 54, 33, 18];

function BarsShape() {
  return (
    <ul className="flex flex-col gap-3">
      {BAR_WIDTHS.map((width) => (
        <li key={width} className="flex flex-col gap-1.5">
          <div className="flex justify-between">
            <Bone className="h-3.5" style={{ width: `${width / 2 + 20}%` }} />
            <Bone className="h-3 w-10" />
          </div>
          <Bone className="h-1.5 rounded-full" style={{ width: `${width}%` }} />
        </li>
      ))}
    </ul>
  );
}

function TableShape({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col">
      <div className="flex gap-6 pb-3">
        <Bone className="h-3 w-24" />
        <Bone className="ml-auto h-3 w-16" />
        <Bone className="h-3 w-12" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-6 border-t py-3">
          <Bone className="h-3.5" style={{ width: `${40 - i * 4}%` }} />
          <Bone className="ml-auto h-3.5 w-16" />
          <Bone className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}

function HeatmapShape() {
  return (
    <div className="overflow-x-hidden">
      <div className="grid min-w-[480px] gap-[3px]" style={{ gridTemplateColumns: "2.5rem repeat(24, minmax(0, 1fr))" }}>
        {Array.from({ length: 7 }, (_, weekday) => (
          <div key={weekday} className="contents">
            <Bone className="mr-2 h-2.5 self-center" />
            {Array.from({ length: 24 }, (_, hour) => (
              <Bone key={hour} className="h-5 rounded-[3px]" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export type ChartSkeletonShape =
  | { kind: "line"; height: number }
  | { kind: "bars" }
  | { kind: "table"; rows: number }
  | { kind: "heatmap" };

/** A chart card with its title, while what it charts is still being read. */
export function ChartCardSkeleton({ title, shape }: { title: string; shape: ChartSkeletonShape }) {
  return (
    <Card aria-busy="true">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {shape.kind === "line" && <LineShape height={shape.height} />}
        {shape.kind === "bars" && <BarsShape />}
        {shape.kind === "table" && <TableShape rows={shape.rows} />}
        {shape.kind === "heatmap" && <HeatmapShape />}
      </CardContent>
    </Card>
  );
}
