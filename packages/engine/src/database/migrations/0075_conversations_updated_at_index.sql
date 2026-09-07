-- Org-wide conversation list: an index that leads with the sort column.
--
-- `listConversations` ends `ORDER BY c.updated_at DESC NULLS LAST LIMIT ... OFFSET`.
-- With an `instanceId` filter that is served perfectly by
-- `idx_conversations_instance_updated` (0055). WITHOUT one — the panel's global
-- conversations page — the filter becomes `c.instance_id IN (subquery over the
-- org's workspaces)`, and the only indexes on the table lead with `instance_id`.
-- Postgres therefore reads every conversation the organization owns and sorts it
-- to return twenty rows, and OFFSET makes each deeper page worse.
--
-- CONCURRENTLY is deliberately NOT used: the migration runner wraps each file in
-- a transaction and CREATE INDEX CONCURRENTLY cannot run inside one. On a large
-- existing table an operator who wants a non-blocking build should create it by
-- hand first — the IF NOT EXISTS below then makes this file a no-op.
CREATE INDEX IF NOT EXISTS "idx_conversations_updated_at"
  ON "conversations" ("updated_at" DESC NULLS LAST);
