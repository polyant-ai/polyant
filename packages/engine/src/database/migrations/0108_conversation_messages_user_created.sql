-- The messages people sent, per conversation in time order: the dashboard's
-- weekday-and-hour distribution reads only these. Without it Postgres found a
-- conversation's messages through idx_conversation_messages_conversation_id and
-- read every one from the table, wide with content and tool steps, to keep the
-- user rows in the window. Partial and covering, it answers from the index.
--
-- Built concurrently, outside a transaction, so the messages table stays
-- readable and writable while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_conversation_messages_user_created"
  ON "conversation_messages" ("conversation_id", "created_at")
  WHERE "role" = 'user';
