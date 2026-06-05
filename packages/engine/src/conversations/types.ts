// SPDX-License-Identifier: AGPL-3.0-or-later

import { type InstanceSlug } from "../instances/identifiers.js";

export interface ConversationRecord {
  id: string;
  conversationId: string;
  summary: string | null;
  instanceId: InstanceSlug | null;
  createdAt: Date;
  updatedAt: Date;
}
