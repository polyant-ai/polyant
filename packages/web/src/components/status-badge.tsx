// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/**
 * How a status reads: a good state, a neutral one (inactive, paused, waiting,
 * running) or a failure.
 */
export type StatusTone = "positive" | "neutral" | "negative";

const VARIANT = { positive: "default", neutral: "secondary", negative: "destructive" } as const;

/** The badge variant a tone is drawn with. */
export function statusVariant(tone: StatusTone): (typeof VARIANT)[StatusTone] {
  return VARIANT[tone];
}

/**
 * The one badge for a status value (Active, Paused, Ready, Pending, Failed,
 * Succeeded) wherever it appears: positive is the default badge, neutral is
 * secondary, a failure is destructive, and there is no icon inside the pill.
 * Labels that are not states (an event, a type, a channel, a category) are a
 * plain `secondary` Badge.
 */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <Badge variant={VARIANT[tone]}>{children}</Badge>;
}
