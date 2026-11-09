// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * What the engine sent the provider and what came back, one row per model
 * request: each step of a call, and each retry of a step. Written only while
 * the agent's debug flag is on, and cleared with the debug payloads after
 * `DEBUG_PAYLOAD_RETENTION_DAYS`: the request is the prompt, with whatever
 * personal data the conversation holds.
 *
 * `response` is the provider's body for a buffered call. A streamed call has
 * no body to keep, so it holds the step the SDK assembled from the stream
 * (`assembled: true`).
 */
export const modelExchanges = pgTable(
  "model_exchanges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The ai_logs row of the call (not a FK: ai_logs is written in batches). */
    aiLogId: uuid("ai_log_id").notNull(),
    messageId: uuid("message_id"),
    conversationId: text("conversation_id"),
    instanceId: text("instance_id"),
    stepIndex: integer("step_index").notNull(),
    attempt: integer("attempt").notNull().default(1),
    /** HTTP status of the provider's answer; null when none came (network error, abort). */
    status: integer("status"),
    request: jsonb("request"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_model_exchanges_ai_log").on(table.aiLogId),
    index("idx_model_exchanges_conversation").on(table.conversationId),
    index("idx_model_exchanges_created").on(table.createdAt),
  ],
);
