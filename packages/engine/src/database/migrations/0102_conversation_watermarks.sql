-- How far the conversation's summary and its memory extraction have read: the
-- created_at of the last message each covers. NULL means nothing yet: the
-- history starts at the first message and extraction has read none.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "summary_through" timestamp with time zone;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "memory_through" timestamp with time zone;
