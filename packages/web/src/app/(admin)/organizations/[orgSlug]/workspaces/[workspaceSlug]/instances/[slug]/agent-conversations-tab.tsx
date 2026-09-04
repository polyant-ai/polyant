// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { ConversationsView } from "@/components/conversations/conversations-view";

/**
 * This agent's conversations: the workspace table, with the agent already
 * answered — same component, so search, pagination and the token pills cannot
 * drift between the two places that show them.
 */
export function AgentConversationsTab({ slug }: { slug: string }) {
  return <ConversationsView lockedInstanceId={slug} />;
}
