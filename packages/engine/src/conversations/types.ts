// SPDX-License-Identifier: AGPL-3.0-or-later

import { type AgentSlug } from "../instances/identifiers.js";

export interface ConversationRecord {
  id: string;
  conversationId: string;
  summary: string | null;
  agentId: AgentSlug | null;
  createdAt: Date;
  updatedAt: Date;
}
