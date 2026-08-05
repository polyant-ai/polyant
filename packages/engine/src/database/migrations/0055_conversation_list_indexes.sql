-- Performance indexes for the conversation-list query (store.ts listConversations/searchConversations).
--
-- 1. ai_logs.conversation_id: the LATERAL token/cost aggregation filters ai_logs by
--    conversation_id per result row. Without this index every listed conversation triggers
--    a sequential scan of the whole (large, append-only) ai_logs table.
-- 2. conversations(instance_id, updated_at): the list filters by instance_id and orders by
--    updated_at DESC. The existing (instance_id, created_at) index does not serve the sort,
--    forcing a full sort of the filtered set before LIMIT.
--
-- ponytail: plain CREATE INDEX locks writes while building. On a very large table run these
-- manually with CREATE INDEX CONCURRENTLY (cannot run inside the migration transaction).

CREATE INDEX IF NOT EXISTS "idx_ai_logs_conversation_id" ON "ai_logs" ("conversation_id");
CREATE INDEX IF NOT EXISTS "idx_conversations_instance_updated" ON "conversations" ("instance_id", "updated_at");
