-- The statements of the release that lock a table every turn reads, together and
-- last: the columns 0102 and 0104 add, and the indexes 0110 and 0111 replaced
-- with wider ones.
--
-- The migration runner applies every pending migration in one transaction, so a
-- lock is held from the statement that takes it until the whole batch commits.
-- ADD COLUMN and DROP INDEX take an ACCESS EXCLUSIVE lock, which stops reads too:
-- run early, they held `conversations`, `ai_logs` and `conversation_messages`
-- while the release's index builds read the large tables, and every turn of a
-- process still serving the previous release waited. As the last statements of
-- the release, the lock lasts from them to the commit right after; each of them
-- changes only the catalog, so that is milliseconds once the lock is granted.
-- CONCURRENTLY cannot run inside a transaction. A deployment that wants no lock
-- on the indexes can run `DROP INDEX CONCURRENTLY` on the three by hand first;
-- IF EXISTS then makes those statements no-ops.

-- How far the conversation's summary and its memory extraction have read: the
-- created_at of the last message each covers. NULL means nothing yet: the
-- history starts at the first message and extraction has read none.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "summary_through" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "memory_through" timestamp with time zone;
--> statement-breakpoint
-- What a service call was for (title, summary, memory, ...), so service spend can
-- be grouped by it. Nullable without a default: every existing row and every
-- conversation call keeps NULL.
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "purpose" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_conversations_instance_updated";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_ai_logs_instance_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_conversation_messages_conversation_id";
