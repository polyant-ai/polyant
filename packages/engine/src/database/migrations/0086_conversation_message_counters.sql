-- Per-conversation message counters, kept with the conversation row.
--
-- The conversation list, the analytics overview, the daily trend and the
-- channel breakdown counted each conversation's messages with a correlated
-- COUNT over conversation_messages, so their cost grew with the tenant's whole
-- history rather than with the page or the window. The counters are written in
-- the same statement that already bumps `updated_at` on every append
-- (ConversationStore.appendMessages), so no write is added.
--
-- `last_message_at` is the exact bound the message-level analytics prune by: a
-- conversation with a message in the window has its last message at or after
-- the window's start. `updated_at` cannot serve, because before appendMessages
-- bumped it only title and summary writes moved it.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "message_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "user_message_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "last_message_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill from history: one pass over conversation_messages.
UPDATE "conversations" c
SET "message_count" = m.n, "user_message_count" = m.u, "last_message_at" = m.last
FROM (
  SELECT "conversation_id", count(*)::int AS n, (count(*) FILTER (WHERE "role" = 'user'))::int AS u, max("created_at") AS last
  FROM "conversation_messages"
  GROUP BY "conversation_id"
) m
WHERE m."conversation_id" = c."conversation_id";
--> statement-breakpoint
-- CONCURRENTLY is deliberately NOT used: the migration runner wraps each file in
-- a transaction and CREATE INDEX CONCURRENTLY cannot run inside one. On a large
-- existing table an operator who wants non-blocking builds should create these
-- by hand first — IF NOT EXISTS then makes them no-ops.
--
-- Message-level analytics: the tenant's conversations with activity in the window.
CREATE INDEX IF NOT EXISTS "idx_conversations_instance_last_message"
  ON "conversations" ("instance_id", "last_message_at");
--> statement-breakpoint
-- One conversation's messages in time order: the per-turn history read
-- (ORDER BY created_at DESC LIMIT n) and the windowed analytics scans.
CREATE INDEX IF NOT EXISTS "idx_conversation_messages_conversation_created"
  ON "conversation_messages" ("conversation_id", "created_at");
