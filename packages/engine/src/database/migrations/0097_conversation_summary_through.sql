-- How many exchanges (user-message ordinals) the conversation summary covers.
-- The history window starts here, so a failed summary refresh keeps the exchanges
-- it did not fold in the window instead of dropping them.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "summary_through" integer;
--> statement-breakpoint
-- Summaries written before the marker: a lower bound of what they cover, so the
-- window never starts past an exchange they lack (it can only repeat one).
-- The previous window read 16 rows and, past 15, kept the last 10 and folded the
-- rest, each turn: an exchange was folded on three consecutive turns. After a
-- landed refresh the unfolded rows are the 10 before the last turn (at most 5
-- user rows) plus that turn's user row, so the summary covers at least
-- user_message_count - 6 exchanges; each failed refresh at the end lowers that by
-- one. Minus 8 holds through two failed final refreshes, the old window's own
-- tolerance: a third lost the exchange there too. System rows only fold more.
-- An engine without the marker still running only extends the summary.
UPDATE "conversations"
SET "summary_through" = GREATEST("user_message_count" - 8, 0)
WHERE "summary" IS NOT NULL AND "summary_through" IS NULL;
