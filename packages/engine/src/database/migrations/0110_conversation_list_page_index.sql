-- The conversation list chooses its page agent by agent: each agent's newest
-- conversations, in the list's own order (`updated_at DESC NULLS LAST, id DESC`),
-- read as a descent of one index. The id tie-break keeps pages from repeating or
-- skipping conversations that share a timestamp.
--
-- It replaces `idx_conversations_instance_updated` (instance_id, updated_at): every
-- query that used that one (an agent's conversations by update time, or in an
-- update-time window) is served by this one, and keeping both would cost a second
-- B-tree on every turn's `updated_at` bump. 0119 drops the old index.
--
-- Built concurrently, outside a transaction, so the table stays readable and
-- writable while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_conversations_instance_updated_id"
  ON "conversations" ("instance_id", "updated_at" DESC NULLS LAST, "id" DESC);
