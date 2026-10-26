-- Two single-column indexes that are the leading column of a composite index on the same table:
-- (conversation_id) of (conversation_id, created_at) and (instance_id) of (instance_id, created_at).
-- The composites serve every lookup the single-column ones served (no foreign key uses either column);
-- every insert into these tables still wrote one entry in each of them.
--
-- Each one is dropped only when its composite exists and is valid: an interrupted
-- CREATE INDEX CONCURRENTLY (the way docs/UPGRADING.md builds the messages one ahead of 0086) leaves an
-- invalid index that `IF NOT EXISTS` skipped, and the single-column index is then the only usable one.
--
-- DROP INDEX takes an ACCESS EXCLUSIVE lock on its table while it waits and runs. On a large installation
-- the two can be dropped beforehand without blocking, and this migration then finds nothing to drop:
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_conversation_messages_conversation_id";
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_ai_logs_instance_id";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('idx_conversation_messages_conversation_created') AND indisvalid) THEN
    DROP INDEX IF EXISTS "idx_conversation_messages_conversation_id";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('idx_ai_logs_instance_created') AND indisvalid) THEN
    DROP INDEX IF EXISTS "idx_ai_logs_instance_id";
  END IF;
END $$;
