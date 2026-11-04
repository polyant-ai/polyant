-- The conversation list chooses its page agent by agent: each agent's newest
-- conversations, in the list's own order (`updated_at DESC NULLS LAST, id DESC`),
-- read as a descent of one index. The id tie-break keeps pages from repeating or
-- skipping conversations that share a timestamp.
--
-- It replaces `idx_conversations_instance_updated` (instance_id, updated_at): every
-- query that used that one (an agent's conversations by update time, or in an
-- update-time window) is served by this one, and keeping both would cost a second
-- B-tree on every turn's `updated_at` bump. The old index is dropped by the last
-- migration of the release (0117), so the lock its drop takes is held only briefly.
--
-- CONCURRENTLY is not used: the migration runner wraps each file in a transaction.
-- On a large table an operator can build the index by hand first; IF NOT EXISTS then
-- makes the CREATE a no-op.
CREATE INDEX IF NOT EXISTS "idx_conversations_instance_updated_id"
  ON "conversations" ("instance_id", "updated_at" DESC NULLS LAST, "id" DESC);
