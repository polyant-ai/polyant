-- The request path reads a turn's model calls and hook runs by message. Built
-- concurrently, outside a transaction: both tables take writes on every turn.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ai_logs_message" ON "ai_logs" ("message_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_hook_executions_message" ON "hook_executions" ("message_id");
