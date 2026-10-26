// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A conversation opened from an agent's own Conversations section carries
 * `?from=agent`: the conversation page then sends «Indietro» back to that section
 * instead of the workspace-wide list. A conversation opened from the list carries
 * nothing and behaves as before.
 */
export const FROM_AGENT_PARAM = "from";
export const FROM_AGENT_VALUE = "agent";

/** The agent's own Conversations section, relative to the workspace. */
export function agentConversationsSubpath(agentSlug: string): string {
  return `/instances/${encodeURIComponent(agentSlug)}?tab=conversations`;
}
