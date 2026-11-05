// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

/** The body of a section whose data, or code, is still arriving. */
export function SectionLoading() {
  return <Skeleton className="h-96 w-full" />;
}

// Charts (Analytics) and markdown with code highlighting (an event in the Room)
// are the two heaviest libraries on the agent page, and the section most links
// land on uses neither: they load when their section opens, showing the section
// skeleton meanwhile.
export const AnalyticsTab = dynamic(() => import("./analytics-tab").then((m) => m.AnalyticsTab), {
  loading: () => <SectionLoading />,
});
export const RoomTab = dynamic(() => import("./room-tab").then((m) => m.RoomTab), {
  loading: () => <SectionLoading />,
});
