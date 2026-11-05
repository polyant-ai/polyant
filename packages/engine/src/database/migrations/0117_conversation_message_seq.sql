-- The order in which a conversation's messages were saved. A message's
-- created_at is when it arrived, so a slow turn saved after a faster, later one
-- has rows older than the other's: a mark kept by created_at skipped them. The
-- memory extraction's mark is kept by this sequence instead.
--
-- Rows saved before this migration keep a NULL seq: the column is added without
-- rewriting the table, and the extraction reads those rows by created_at until
-- its first mark by seq.
CREATE SEQUENCE IF NOT EXISTS "conversation_messages_seq_seq" AS bigint;
ALTER TABLE "conversation_messages" ADD COLUMN IF NOT EXISTS "seq" bigint;
ALTER TABLE "conversation_messages" ALTER COLUMN "seq" SET DEFAULT nextval('conversation_messages_seq_seq');
ALTER SEQUENCE "conversation_messages_seq_seq" OWNED BY "conversation_messages"."seq";
-- The seq of the last message memory extraction has read.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "memory_through_seq" bigint;
