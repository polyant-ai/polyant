// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NarrativeToken } from "./narrative";

/**
 * Visual treatment per narrative token type. The intent is that "text"
 * tokens fade into the background while the important named tokens (agent,
 * tool, channel, duration, sender, gate) catch the eye.
 *
 *  - subject / sender → bold + foreground (max contrast for the actor)
 *  - tool / channel   → small mono pill, color-coded by category
 *  - duration         → mono bold, tabular-nums (so digits don't jiggle)
 *  - gate / phase     → mono, no pill (already inside parentheses)
 *  - count            → tabular-nums (numeric emphasis)
 */
export function NarrativeTokenView({ token }: { token: NarrativeToken }) {
  switch (token.type) {
    case "text":
      return <>{token.value}</>;
    case "subject":
    case "sender":
      return (
        <span className="text-foreground font-semibold">{token.value}</span>
      );
    case "tool":
      return (
        <span className="bg-blue-500/10 text-blue-700 dark:text-blue-300 inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-xs font-semibold">
          {token.value}
        </span>
      );
    case "channel":
      return (
        <span className="bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-xs font-medium">
          {token.value}
        </span>
      );
    case "duration":
      return (
        <span className="text-foreground font-mono font-semibold tabular-nums">
          {token.value}
        </span>
      );
    case "gate":
      return <span className="font-mono text-xs">{token.value}</span>;
    case "phase":
      return <span className="font-mono text-xs italic">{token.value}</span>;
    case "count":
      return <span className="text-foreground font-semibold tabular-nums">{token.value}</span>;
  }
}
