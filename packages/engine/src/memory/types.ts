// SPDX-License-Identifier: AGPL-3.0-or-later

import { type InstanceSlug } from "../instances/identifiers.js";

/** A memory stored in PostgreSQL. */
export interface Memory {
  id: string;
  instanceId: InstanceSlug;
  content: string;
  category: string;
  importance: number;
  sourceConversationId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Result from inserting/upserting a memory. */
export interface MemoryUpsertResult {
  id: string;
  content: string;
  event: "ADD" | "UPDATE";
}

/** A fact extracted by the LLM before embedding. */
export interface ExtractedFact {
  content: string;
  category: "preference" | "fact" | "event" | "relationship" | "decision" | "general";
  importance: number;
}
