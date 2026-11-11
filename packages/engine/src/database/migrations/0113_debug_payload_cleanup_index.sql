-- The daily cleanup clears debug payloads older than their window. Only debug-mode
-- turns carry one, so a partial index on their time finds them without reading
-- every old message.
--
-- Built concurrently, outside a transaction, so the messages table stays
-- readable and writable while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_conversation_messages_debug_created"
  ON "conversation_messages" ("created_at") WHERE "debug_payload" IS NOT NULL;
