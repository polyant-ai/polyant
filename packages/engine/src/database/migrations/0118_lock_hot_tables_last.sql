-- Columns of the release on tables every turn reads, kept here from 0102 and 0104
-- so their order in the table does not depend on the database's history.
--
-- ADD COLUMN takes an ACCESS EXCLUSIVE lock, which stops reads too. Each
-- migration commits on its own and none of these rewrites the table, so the lock
-- lasts milliseconds once granted; the runner's lock_timeout keeps it from
-- queueing for long behind a running query.

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
