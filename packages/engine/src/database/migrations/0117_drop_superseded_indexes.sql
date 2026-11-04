-- Drops the indexes that 0110 and 0111 replaced with wider ones.
--
-- The migration runner applies every pending migration in one transaction, so a
-- lock is held from the statement that takes it until the whole batch commits.
-- DROP INDEX takes an ACCESS EXCLUSIVE lock on its table, which stops reads too:
-- run first, it held `conversations`, `ai_logs` and `conversation_messages` while
-- the release's index builds read the large tables, and every turn of a process
-- still serving the previous release waited. As the last statements of the
-- release, the lock lasts from these drops to the commit right after them.
-- CONCURRENTLY cannot run inside a transaction. A deployment that wants no lock
-- at all can run `DROP INDEX CONCURRENTLY` on the three indexes by hand first;
-- IF EXISTS then makes these statements no-ops.
DROP INDEX IF EXISTS "idx_conversations_instance_updated";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_ai_logs_instance_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_conversation_messages_conversation_id";
